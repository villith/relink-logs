import type { ActionType, CharacterType, GroupAggregate, GroupKey, GroupMeasure, MergedMeasure } from "@/types";
import { humanizeNumber, isSupplementaryAction } from "@/utils";

import { abilityKey, skillKey } from "../../abilityKey";
import { abilityRowKey, groupOfPin, type RowKeying } from "../../abilitySkills";
import { damageColumns, playersColumns } from "../../metrics/damageDone";
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
  /** Whether rows report LANDINGS (an echo folded into the hit that caused it)
   * or raw events. Follows the same toggle `keying.collapseSupplementary`
   * carries, passed explicitly so this fold never has to infer a display rule
   * from a keying rule. */
  merged?: boolean;
};

/** Shown where a measure never recorded an extreme (a walk with no per-hit
 * min/max) — same convention as the metric descriptors. */
const NOT_RECORDED = "—";

const format = humanizeNumber;

const extreme = (value: number | null): string => (value === null ? NOT_RECORDED : format(value));

/** The numeric cells for one measure, in the exact shape the metric's
 * `columnKeys(groupBy)` headers promise (see CAPABILITIES): the source
 * grouping keeps each metric's players-level shape, everything else fills the
 * metric's drill-down shape. */
const columnsFor = (ctx: GroupRowsContext, measure: GroupMeasure, total: number): string[] => {
  const { amount, hits } = measure;
  if (ctx.groupBy === "source") {
    // Both metrics' `columnKeys("players")` promise the same shape here, so
    // this branch is metric-agnostic.
    return playersColumns(amount, total, ctx.fightDurationMs);
  }
  return ctx.metric === "damage"
    ? damageColumns(amount, hits, extreme(measure.min), extreme(measure.max), total)
    : drilldownColumns(amount, hits, ctx.fightDurationMs);
};

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

const addMeasure = (into: GroupMeasure, measure: GroupMeasure): void => {
  into.amount += measure.amount;
  into.hits += measure.hits;
  into.min = foldMin(into.min, measure.min);
  into.max = foldMax(into.max, measure.max);
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

const addSplit = (into: SplitMeasure, aggregate: Pick<GroupAggregate, "measure" | "merged">, echo: boolean): void => {
  addMeasure(into.raw, aggregate.measure);
  addMeasure(into.merged, aggregate.merged);
  into.merged.supplementary += aggregate.merged.supplementary;
  if (echo) into.rawSupplementary += aggregate.measure.amount;
};

/** Which view's figures the columns are filled from. */
const reportedMeasure = (ctx: GroupRowsContext, split: SplitMeasure): GroupMeasure =>
  ctx.merged === true ? split.merged : split.raw;

/** The echo share to draw as the fainter bar segment, or undefined where there
 * is none — absent rather than 0, which would mount an empty segment.
 *
 * The merged view reads the backend's figure and CANNOT infer it the way the
 * raw view does. Once every echo folds onto its trigger, no echo aggregate
 * reaches the bucket at all, so a bucket test finds nothing and a row with a
 * real 92.7k echo share would draw one flat bar.
 *
 * `echo < amount` is the "mixed" rule both views still need: a row that is
 * supplementary ALL the way across — the echo row, or the residue a collapse
 * leaves behind — is already described by its own label, and painting the whole
 * bar in the fainter shade would say nothing. */
const subValueOf = (ctx: GroupRowsContext, split: SplitMeasure): { subValue?: number } => {
  const amount = reportedMeasure(ctx, split).amount;
  const echo = ctx.merged === true ? split.merged.supplementary : split.rawSupplementary;
  return echo > 0 && echo < amount ? { subValue: echo } : {};
};

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
    switch (key.kind) {
      case "player":
        rows.push({
          key: playerRowKey(key.index),
          label: String(key.index),
          kind: "player",
          value: measure.amount,
          columns: columnsFor(ctx, ctx.merged === true ? merged : measure, total),
          pinOnClick: pinFor(ctx, key.index),
          colorSlot: ctx.partySlots.get(key.index) ?? -1,
        });
        break;

      case "enemySpawn":
        rows.push({
          key: spawnRowKey(key.segment),
          label: spawnRowKey(key.segment),
          kind: "target",
          value: measure.amount,
          columns: columnsFor(ctx, ctx.merged === true ? merged : measure, total),
          pinOnClick: pinFor(ctx, key.segment),
          colorSlot: -1,
        });
        break;

      case "enemyType": {
        // A type merges same-type spawns, so it cannot pick one to pin.
        const label = JSON.stringify(key.enemyType);
        rows.push({
          key: enemyRowKey(key.enemyType),
          label,
          kind: "enemy",
          value: measure.amount,
          columns: columnsFor(ctx, ctx.merged === true ? merged : measure, total),
          pinOnClick: null,
          colorSlot: -1,
        });
        break;
      }

      case "enemyAttack": {
        // The takenAttack grammar: the label IS the JSON `takenAttackRowParts`
        // reads, and the pin carries it on the ability axis.
        const label = takenAttackRowLabel(key.enemyType, key.actionId);
        rows.push({
          key: takenRowKey(label),
          label,
          kind: "takenAttack",
          value: measure.amount,
          columns: columnsFor(ctx, ctx.merged === true ? merged : measure, total),
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
        addSplit(bucket, { measure, merged }, echo);

        // An echo joins the member that CAUSED it rather than standing as a
        // member of its own: a skill group holds skills, and "Supplementary
        // Damage" is not one of them — while dropping the echo outright would
        // stop the children summing to the parent they expand. Unresolvable
        // (or uncollapsed), the echo is its own member, which is also its own
        // row, so nothing is folded anywhere it does not belong.
        const cause = echo
          ? ctx.keying?.causeAction(
              (key.actionType as { SupplementaryDamage: number }).SupplementaryDamage,
              key.childCharacterType
            ) ?? null
          : null;
        // Members merge by action ALONE (`mergeSkillsByAction`'s rule): a
        // player and their summon on one action id are one member skill, and
        // Primal Burst's three bodies share one id on purpose.
        const memberAction = cause ?? key.actionType;
        const memberKey = abilityKey(memberAction);
        const member = bucket.members.get(memberKey) ?? { actionType: memberAction, split: emptySplit() };
        addSplit(member.split, { measure, merged }, echo);
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
            .map(
              ([memberKey, member]): MetricRow => ({
                key: skillKey(memberKey),
                label: memberKey,
                kind: "ability",
                value: ctx.merged === true ? member.split.merged.amount : member.split.raw.amount,
                ...subValueOf(ctx, member.split),
                columns: columnsFor(ctx, reportedMeasure(ctx, member.split), total),
                pinOnClick: { ability: memberKey },
                colorSlot: abilitySlot,
              })
            )
            .sort((a, b) => b.value - a.value);

    rows.push({
      key: skillKey(rowKey),
      label: rowKey,
      kind: "ability",
      value: ctx.merged === true ? bucket.merged.amount : bucket.raw.amount,
      ...subValueOf(ctx, bucket),
      columns: columnsFor(ctx, reportedMeasure(ctx, bucket), total),
      pinOnClick: { ability: rowKey },
      colorSlot: abilitySlot,
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
