import type {
  ActionType,
  CharacterType,
  FactTally,
  GroupAggregate,
  GroupFacts,
  GroupKey,
  GroupMeasure,
  MergedMeasure,
} from "@/types";
import { humanizeNumber, isSupplementaryAction } from "@/utils";

import { abilityKey, skillKey } from "../../abilityKey";
import { abilityRowKey, groupOfPin, supplementarySubValue, type RowKeying } from "../../abilitySkills";
import { damageColumns, factColumns, playersColumns } from "../../metrics/damageDone";
import { drilldownColumns } from "../../metrics/damageTaken";
import type { Hostility, MetricRow } from "../../metrics/types";
import { enemyRowKey, playerRowKey, spawnRowKey, takenAttackRowLabel, takenRowKey } from "../../rowKey";
import type { Dimension } from "./state";

/** What the fold needs to know beyond the aggregates themselves — which
 * metric's column shapes to fill, which dimension the rows ARE (a row click
 * pins that dimension), and the party facts behind row colours. */
export type GroupRowsContext = {
  metric: "damage" | "taken";
  groupBy: Dimension;
  hostility: Hostility;
  /** `ComputedPlayerState.index` → `partyIndex`, for player-row colours. */
  partySlots: Map<number, number>;
  /** The pinned friendly source, colouring one player's ability rows the way
   * damageDone always has; null (or an enemy-side pin) colours none. */
  source: number | null;
  fightDurationMs?: number;
  /** The view's row keying — today, whether echo damage rides the skill that
   * caused it. Passed rather than rebuilt for the same reason the descriptors
   * take one: the table, the chart bands and the timeline's lane join must
   * agree about which row an echo is on, and deriving it three times is how
   * they would come to differ. Absent = the uncollapsed fold. */
  keying?: RowKeying;
};

/** Shown where a measure never recorded an extreme (a walk with no per-hit
 * min/max) — same convention as the metric descriptors. */
const NOT_RECORDED = "—";

const format = humanizeNumber;

const extreme = (value: number | null): string => (value === null ? NOT_RECORDED : format(value));

/** The numeric cells for one measure, in the exact shape the metric's
 * `columnKeys(groupBy)` headers promise (see CAPABILITIES): the source
 * grouping keeps each metric's players-level shape, everything else fills the
 * metric's drill-down shape.
 *
 * `facts` is a SEPARATE parameter from `measure` rather than read off it,
 * because `measure` here is the REPORTED view — raw or landings, per the
 * collapse toggle — and a `MergedMeasure` never carries facts at all (see
 * `GroupFacts`'s doc). The caller passes the row's own RAW facts regardless
 * of which view its other cells report, so the crit/WP/BA rate never goes
 * blank just because the reader turned Merge Sup DMG on. */
const columnsFor = (ctx: GroupRowsContext, measure: GroupMeasure, total: number, facts?: GroupFacts): string[] => {
  const { amount, hits } = measure;
  const base = (() => {
    if (ctx.groupBy === "source") {
      // Both metrics' `columnKeys("players")` promise the same shape here, so
      // this branch is metric-agnostic.
      return playersColumns(amount, total, ctx.fightDurationMs);
    }
    return ctx.metric === "damage"
      ? damageColumns(amount, hits, extreme(measure.min), extreme(measure.max), total)
      : drilldownColumns(amount, hits, ctx.fightDurationMs);
  })();
  // Crit/WP/BA are a damage-only reading — `damageTaken.columnKeys` promises
  // no such cells, and appending them there would render three columns past
  // what its own header row declares.
  return ctx.metric === "damage" ? [...base, ...factColumns(facts)] : base;
};

/** The row's own fact tallies, gated on the METRIC rather than on whether the
 * measure happens to carry them.
 *
 * `GroupMeasure.facts` is documented absent on `taken` rows, but a row/column
 * fold that trusted that alone is one backend skew away from lighting the
 * hover card's "Damage facts" section on a taken row the day that contract
 * slips. Every attachment site — the three column shapes above and every
 * `MetricRow.facts` spread below — reads through here instead of `measure`
 * directly, so `MetricTable`'s forwarding of `row.facts` into the hover card
 * inherits the gate for free. */
const factsOf = (ctx: GroupRowsContext, measure: GroupMeasure): GroupFacts | undefined =>
  ctx.metric === "damage" ? measure.facts : undefined;

/** What clicking a row pins: always the dimension the table is grouped by,
 * carried in the existing `SelectorPins` wire shape (`source`/`targets[0]`/
 * `ability` ↔ the machine's three dimensions). The VALUE's universe follows
 * the hostility role-mapping, exactly as `state.source`/`state.target` do. */
const pinFor = (ctx: GroupRowsContext, value: number | string): MetricRow["pinOnClick"] =>
  ctx.groupBy === "source"
    ? { source: value as number }
    : ctx.groupBy === "target"
      ? { targets: [value as number] }
      : { ability: value as string };

const foldMin = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);
const foldMax = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

const addFactTally = (a: FactTally, b: FactTally): FactTally => ({
  measuredYes: a.measuredYes + b.measuredYes,
  measuredNo: a.measuredNo + b.measuredNo,
  inferredYes: a.inferredYes + b.inferredYes,
  inferredNo: a.inferredNo + b.inferredNo,
  unknown: a.unknown + b.unknown,
});

/** Field-wise `GroupFacts` sum, absent-safe like `foldMin`/`foldMax` above: one
 * side missing keeps the other, both missing stays absent. A skill group is
 * several backend aggregates folded into one row, and facts fold the same way
 * every other field here does — sibling-action summing IS the same
 * aggregation a single row's own facts already are, unlike the mixed `other`
 * tail (which never reaches `addMeasure` at all; see the `case "other"` below).
 * Echo aggregates carry no facts of their own (tallied from direct hits
 * only), so folding one in is a no-op here — exactly the "both absent" case. */
const addFacts = (a: GroupFacts | undefined, b: GroupFacts | undefined): GroupFacts | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    crit: addFactTally(a.crit, b.crit),
    weakPoint: addFactTally(a.weakPoint, b.weakPoint),
    backAttack: addFactTally(a.backAttack, b.backAttack),
    debuffed: addFactTally(a.debuffed, b.debuffed),
    overdrive: addFactTally(a.overdrive, b.overdrive),
    break: addFactTally(a.break, b.break),
    overdriveDamage: a.overdriveDamage + b.overdriveDamage,
    breakDamage: a.breakDamage + b.breakDamage,
  };
};

const addMeasure = (into: GroupMeasure, measure: GroupMeasure): void => {
  into.amount += measure.amount;
  into.hits += measure.hits;
  into.min = foldMin(into.min, measure.min);
  into.max = foldMax(into.max, measure.max);
  into.facts = addFacts(into.facts, measure.facts);
};

const emptyMeasure = (): GroupMeasure => ({ amount: 0, hits: 0, min: null, max: null });

type FriendlyAbilityKey = Extract<GroupKey, { kind: "friendlyAbility" }>;

/** One row's totals in BOTH views, plus each view's echo share.
 *
 * The two are folded side by side rather than one being derived from the other:
 * they answer different questions — events versus landings — and only the
 * backend can compute the second, because a `GroupMeasure` has already lost the
 * per-hit identity an echo would have to be attached to.
 *
 * `rawSupplementary` is `splitSupplementary`'s `mixed` test at aggregate grain:
 * the echo aggregates that landed in this bucket because a collapse keyed them
 * here. `merged.supplementary` is the backend's own figure and needs no such
 * test — see `subValueOf`. */
type SplitMeasure = {
  raw: GroupMeasure;
  merged: MergedMeasure;
  /** Echo damage in the RAW view's bucket. */
  rawSupplementary: number;
};

const emptySplit = (): SplitMeasure => ({
  raw: emptyMeasure(),
  merged: { ...emptyMeasure(), supplementary: 0 },
  rawSupplementary: 0,
});

/** `folded` — this aggregate is an echo the collapse moved onto the row of the
 * hit that caused it, which makes its landing view a RESIDUE rather than a
 * measure of its own.
 *
 * An echo aggregate's merged half holds only what the pairing left unclaimed
 * (`MergedMeasure`), and the backend counts each of those as a landing —
 * correct where the residue stands as its own row, wrong here. The echo's
 * payload IS its cause's action id, so the damage belongs on this row; the hit
 * does not, because the trigger it rode is already one of the hits counted here
 * — the pairing simply could not say which. Counting it read Eustace's 360
 * normal attacks as 361 the moment the merge was switched on (log 2586), and
 * let a fragment of a landing stand as the row's minimum. */
const addSplit = (
  into: SplitMeasure,
  aggregate: Pick<GroupAggregate, "measure" | "merged">,
  echo: boolean,
  folded: boolean
): void => {
  addMeasure(into.raw, aggregate.measure);
  if (folded) into.merged.amount += aggregate.merged.amount;
  else addMeasure(into.merged, aggregate.merged);
  into.merged.supplementary += aggregate.merged.supplementary;
  if (echo) into.rawSupplementary += aggregate.measure.amount;
};

/** Whether rows report LANDINGS (an echo folded into the hit that caused it) or
 * raw events.
 *
 * Read off the row keying rather than carried beside it: an echo sits on its
 * cause's row exactly when its damage is counted there, so the two are one
 * decision. Held as two knobs they can be set out of step, and a merged keying
 * filled with raw figures is a table whose rows list abilities the numbers
 * beside them do not describe. */
const reportsLandings = (ctx: GroupRowsContext): boolean => ctx.keying?.collapseSupplementary === true;

/** Which view's figures the columns are filled from. */
const reportedMeasure = (ctx: GroupRowsContext, split: SplitMeasure): GroupMeasure =>
  reportsLandings(ctx) ? split.merged : split.raw;

/** The echo share to draw as the fainter bar segment, or undefined where there
 * is none — absent rather than 0, which would mount an empty segment.
 *
 * The merged view reads the backend's figure and CANNOT infer it the way the
 * raw view does. Once every echo folds onto its trigger, no echo aggregate
 * reaches the bucket at all, so a bucket test finds nothing and a row with a
 * real 92.7k echo share would draw one flat bar.
 *
 * Which echo figure that is differs by view; the test applied to it does not,
 * so `supplementarySubValue` owns that half for every bar in the app. */
const subValueOf = (ctx: GroupRowsContext, split: SplitMeasure): { subValue?: number } =>
  supplementarySubValue(
    reportsLandings(ctx) ? split.merged.supplementary : split.rawSupplementary,
    reportedMeasure(ctx, split).amount
  );

/** One ability row in the making: the row's own split plus the member
 * aggregates behind it, kept so a skill-group parent can list them. */
type AbilityBucket = SplitMeasure & {
  members: Map<string, { actionType: ActionType; split: SplitMeasure }>;
};

const abilityRowOf = (key: FriendlyAbilityKey, keying?: RowKeying): string =>
  abilityRowKey({ actionType: key.actionType, childCharacterType: key.childCharacterType as CharacterType }, keying);

/** Flat backend aggregates → `MetricRow`s, spelled in the SAME key grammars
 * clicking has always pinned (`player:<i>`, `skill:<key>`, `target:<seg>`,
 * `enemy:<json>`, `taken:<json>`), so a groups-path row click behaves exactly
 * like its legacy counterpart. Friendly abilities fold by the one skill-group
 * rule (`abilityRowKey`); a group parent carries its members as `children`,
 * each pinnable by its raw action. Rows sort by amount descending with the
 * `other` rollup pinned last — it is the tail, wherever its sum would rank. */
export const groupRowsFor = (aggregates: GroupAggregate[], ctx: GroupRowsContext): MetricRow[] => {
  // `other` is EXCLUDED from the denominator. `aggregate_groups` appends it
  // without removing the rows it sums ("top_n never removes a row"), so
  // counting it would add the tail twice and every row's share would come out
  // low against a total no reading of the fight produces.
  const total = aggregates.reduce(
    (sum, aggregate) => (aggregate.key.kind === "other" ? sum : sum + aggregate.measure.amount),
    0
  );

  // The pinned player's slot colours ability rows, exactly as damageDone
  // colours a pinned breakdown. Only a friendly-side pin names a player —
  // on the enemy side `source` is a spawn segment in a colliding id space.
  const abilitySlot = ctx.hostility === "friendly" && ctx.source !== null ? ctx.partySlots.get(ctx.source) ?? -1 : -1;

  const rows: MetricRow[] = [];
  // Friendly abilities fold across aggregates (a skill group is several
  // backend keys, one row), so they collect here and materialize after.
  const abilityBuckets = new Map<string, AbilityBucket>();

  for (const { key, measure, merged } of aggregates) {
    // ONE view per row, read once: the bar's length and the total printed
    // beside it come from the same measure or they contradict each other.
    const view = reportsLandings(ctx) ? merged : measure;
    switch (key.kind) {
      case "player": {
        const facts = factsOf(ctx, measure);
        rows.push({
          key: playerRowKey(key.index),
          label: String(key.index),
          kind: "player",
          value: view.amount,
          columns: columnsFor(ctx, view, total, facts),
          pinOnClick: pinFor(ctx, key.index),
          colorSlot: ctx.partySlots.get(key.index) ?? -1,
          ...(facts !== undefined ? { facts } : {}),
        });
        break;
      }

      case "enemySpawn": {
        const facts = factsOf(ctx, measure);
        rows.push({
          key: spawnRowKey(key.segment),
          label: spawnRowKey(key.segment),
          kind: "target",
          value: view.amount,
          columns: columnsFor(ctx, view, total, facts),
          pinOnClick: pinFor(ctx, key.segment),
          colorSlot: -1,
          ...(facts !== undefined ? { facts } : {}),
        });
        break;
      }

      case "enemyType": {
        // A type merges same-type spawns, so it cannot pick one to pin.
        const label = JSON.stringify(key.enemyType);
        const facts = factsOf(ctx, measure);
        rows.push({
          key: enemyRowKey(key.enemyType),
          label,
          kind: "enemy",
          value: view.amount,
          columns: columnsFor(ctx, view, total, facts),
          pinOnClick: null,
          colorSlot: -1,
          ...(facts !== undefined ? { facts } : {}),
        });
        break;
      }

      case "enemyAttack": {
        // The takenAttack grammar: the label IS the JSON `takenAttackRowParts`
        // reads, and the pin carries it on the ability axis.
        //
        // Reading the landing view is not a formality on this key, or on the
        // two enemy ones: a trigger and its echo carry DIFFERENT action ids,
        // and the pairing can claim across targets, so a claim really does
        // move damage between these rows.
        const label = takenAttackRowLabel(key.enemyType, key.actionId);
        rows.push({
          key: takenRowKey(label),
          label,
          kind: "takenAttack",
          value: view.amount,
          columns: columnsFor(ctx, view, total),
          pinOnClick: ctx.groupBy === "ability" ? { ability: label } : null,
          colorSlot: -1,
        });
        break;
      }

      case "friendlyAbility": {
        const rowKey = abilityRowOf(key, ctx.keying);
        const bucket = abilityBuckets.get(rowKey) ?? { ...emptySplit(), members: new Map() };
        // Which half this aggregate is. With the collapse off a bucket is never
        // mixed — every echo keys to the echo row — so this costs nothing there
        // and the row comes out exactly as it always has.
        const echo = isSupplementaryAction(key.actionType);

        // An echo joins the member that CAUSED it rather than standing as a
        // member of its own: a skill group holds skills, and "Supplementary
        // Damage" is not one of them — while dropping the echo outright would
        // stop the children summing to the parent they expand. Unresolvable
        // (or uncollapsed), the echo is its own member, which is also its own
        // row, so nothing is folded anywhere it does not belong.
        //
        // Read before either `addSplit` below rather than after: a resolved
        // cause is exactly what makes this aggregate a folded one at BOTH
        // grains, and `abilityRowOf` above reached the same answer through
        // `causeRow` — one map, so the row and the member cannot disagree about
        // whether the echo moved.
        const cause = echo
          ? ctx.keying?.causeAction(
              (key.actionType as { SupplementaryDamage: number }).SupplementaryDamage,
              key.childCharacterType
            ) ?? null
          : null;
        const folded = cause !== null;
        addSplit(bucket, { measure, merged }, echo, folded);
        // Members merge by action ALONE (`mergeSkillsByAction`'s rule): a
        // player and their summon on one action id are one member skill, and
        // Primal Burst's three bodies share one id on purpose.
        const memberAction = cause ?? key.actionType;
        const memberKey = abilityKey(memberAction);
        const member = bucket.members.get(memberKey) ?? { actionType: memberAction, split: emptySplit() };
        addSplit(member.split, { measure, merged }, echo, folded);
        bucket.members.set(memberKey, member);
        abilityBuckets.set(rowKey, bucket);
        break;
      }

      case "other":
        // Chart-only. The backend keeps every real row and APPENDS this one
        // summing the tail past topN, so `groupBandsFor` can slice — the
        // table already lists the whole tail, and a rendered `other` row
        // double-counts abilities sitting right above it.
        break;
    }
  }

  for (const [rowKey, bucket] of abilityBuckets) {
    // Only a GROUP row decomposes: an ungrouped row (or the echo fold) is one
    // ability already, and a child restating it would say nothing new.
    //
    // A member draws its own split for the same reason its parent does — the
    // echo it carries is its own, folded there by cause.
    const children =
      groupOfPin(rowKey) === null
        ? undefined
        : [...bucket.members.entries()]
            .map(([memberKey, member]): MetricRow => {
              const facts = factsOf(ctx, member.split.raw);
              return {
                key: skillKey(memberKey),
                label: memberKey,
                kind: "ability",
                value: reportedMeasure(ctx, member.split).amount,
                ...subValueOf(ctx, member.split),
                columns: columnsFor(ctx, reportedMeasure(ctx, member.split), total, facts),
                pinOnClick: { ability: memberKey },
                colorSlot: abilitySlot,
                ...(facts !== undefined ? { facts } : {}),
              };
            })
            .sort((a, b) => b.value - a.value);

    const bucketFacts = factsOf(ctx, bucket.raw);
    rows.push({
      key: skillKey(rowKey),
      label: rowKey,
      kind: "ability",
      value: reportedMeasure(ctx, bucket).amount,
      ...subValueOf(ctx, bucket),
      columns: columnsFor(ctx, reportedMeasure(ctx, bucket), total, bucketFacts),
      pinOnClick: { ability: rowKey },
      colorSlot: abilitySlot,
      ...(bucketFacts !== undefined ? { facts: bucketFacts } : {}),
      ...(children === undefined ? {} : { children }),
    });
  }

  return rows.sort((a, b) => b.value - a.value);
};

/** One chart band per aggregate, keyed by the SAME row-key grammar
 * `groupRowsFor` gives the table, with friendly abilities folded by the same
 * skill-group rule (summing their series) — so a band and the row it
 * decomposes are one thing, which is the whole point of the shared
 * aggregation. Sorted largest-first with `other` last, like the rows.
 *
 * The backend's own `other` band is DROPPED. `aggregate_groups` sorts
 * largest-first and then APPENDS `other` summing ranks `topN..` while keeping
 * every individual row for the table — so the real rows already carry the whole
 * fight, and stacking `other` beside them draws the tail twice. Every real band
 * is returned instead, and `topN` only MARKS the ones past the cap as `tail`.
 *
 * The chart plots the tail hidden and rolls it up itself, from whichever tail
 * bands are still hidden (see `chartRollup`): that is what lets one be switched
 * on without the stack standing that band too tall, which slicing here could
 * never allow — a sliced band has no series left to draw.
 *
 * The cap is applied AFTER the skill-group fold, on the folded ranking. Applied
 * before it, a group split across several backend rows spent several of the
 * cap's places and the plot drew fewer bands than it was asked for — which is
 * how a top-8 cap came to show six abilities and one lump. */
/** The band key one aggregate key folds onto — the view's own row-key grammar,
 * in ONE place.
 *
 * Shared with the colour reference (`referenceBandOrder`), which ranks the same
 * bands by their whole-fight totals. A second spelling of this grammar would
 * rank keys no band ever asks about, and every band would silently fall back to
 * its drawn position — the fault the reference exists to fix. */
export const bandKeyOf = (key: Exclude<GroupKey, { kind: "other" }>, keying?: RowKeying): string =>
  key.kind === "player"
    ? playerRowKey(key.index)
    : key.kind === "enemySpawn"
      ? spawnRowKey(key.segment)
      : key.kind === "enemyType"
        ? enemyRowKey(key.enemyType)
        : key.kind === "enemyAttack"
          ? takenRowKey(takenAttackRowLabel(key.enemyType, key.actionId))
          : skillKey(abilityRowOf(key, keying));

export const groupBandsFor = (
  aggregates: GroupAggregate[],
  topN?: number,
  keying?: RowKeying
): { key: string; values: number[]; tail?: boolean }[] => {
  const bands = new Map<string, number[]>();
  for (const { key, series } of aggregates) {
    // The backend's rollup duplicates rows in this same list.
    if (key.kind === "other") continue;
    const bandKey = bandKeyOf(key, keying);
    const found = bands.get(bandKey);
    if (found) {
      for (let bucket = 0; bucket < series.length; bucket++) found[bucket] = (found[bucket] ?? 0) + series[bucket];
    } else {
      bands.set(bandKey, [...series]);
    }
  }
  return [...bands.entries()]
    .map(([key, values]) => ({ key, values, total: values.reduce((sum, value) => sum + value, 0) }))
    .sort((a, b) => b.total - a.total)
    .map(({ key, values }, rank) => ({ key, values, ...(topN !== undefined && rank >= topN ? { tail: true } : {}) }));
};
