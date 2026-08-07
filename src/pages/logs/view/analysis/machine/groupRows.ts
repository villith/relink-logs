import type { ActionType, CharacterType, GroupAggregate, GroupKey, GroupMeasure } from "@/types";
import { humanizeNumber } from "@/utils";

import { abilityKey, skillKey } from "../../abilityKey";
import { abilityRowKey, groupOfPin } from "../../abilitySkills";
import { damageColumns, enemyRowKey, playersColumns } from "../../metrics/damageDone";
import { drilldownColumns } from "../../metrics/damageTaken";
import type { Hostility, MetricRow } from "../../metrics/types";
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

/** One ability row in the making: the summed measure plus the member
 * aggregates behind it, kept so a skill-group parent can list them. */
type AbilityBucket = { measure: GroupMeasure; members: Map<string, { actionType: ActionType; measure: GroupMeasure }> };

const abilityRowOf = (key: FriendlyAbilityKey): string =>
  abilityRowKey({ actionType: key.actionType, childCharacterType: key.childCharacterType as CharacterType });

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

  for (const { key, measure } of aggregates) {
    switch (key.kind) {
      case "player":
        rows.push({
          key: `player:${key.index}`,
          label: String(key.index),
          kind: "player",
          value: measure.amount,
          columns: columnsFor(ctx, measure, total),
          pinOnClick: pinFor(ctx, key.index),
          colorSlot: ctx.partySlots.get(key.index) ?? -1,
        });
        break;

      case "enemySpawn":
        rows.push({
          key: `target:${key.segment}`,
          label: `target:${key.segment}`,
          kind: "target",
          value: measure.amount,
          columns: columnsFor(ctx, measure, total),
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
          columns: columnsFor(ctx, measure, total),
          pinOnClick: null,
          colorSlot: -1,
        });
        break;
      }

      case "enemyAttack": {
        // The takenAttack grammar: the label IS the JSON `takenAttackRowParts`
        // reads, and the pin carries it on the ability axis.
        const label = JSON.stringify({ enemyType: key.enemyType, actionId: key.actionId });
        rows.push({
          key: `taken:${label}`,
          label,
          kind: "takenAttack",
          value: measure.amount,
          columns: columnsFor(ctx, measure, total),
          pinOnClick: ctx.groupBy === "ability" ? { ability: label } : null,
          colorSlot: -1,
        });
        break;
      }

      case "friendlyAbility": {
        const rowKey = abilityRowOf(key);
        const bucket = abilityBuckets.get(rowKey) ?? { measure: emptyMeasure(), members: new Map() };
        addMeasure(bucket.measure, measure);
        // Members merge by action ALONE (`mergeSkillsByAction`'s rule): a
        // player and their summon on one action id are one member skill, and
        // Primal Burst's three bodies share one id on purpose.
        const memberKey = abilityKey(key.actionType);
        const member = bucket.members.get(memberKey) ?? { actionType: key.actionType, measure: emptyMeasure() };
        addMeasure(member.measure, measure);
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
    const children =
      groupOfPin(rowKey) === null
        ? undefined
        : [...bucket.members.entries()]
            .map(
              ([memberKey, member]): MetricRow => ({
                key: skillKey(memberKey),
                label: memberKey,
                kind: "ability",
                value: member.measure.amount,
                columns: columnsFor(ctx, member.measure, total),
                pinOnClick: { ability: memberKey },
                colorSlot: abilitySlot,
              })
            )
            .sort((a, b) => b.value - a.value);

    rows.push({
      key: skillKey(rowKey),
      label: rowKey,
      kind: "ability",
      value: bucket.measure.amount,
      columns: columnsFor(ctx, bucket.measure, total),
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
 * `topN` is the CHART's half of the backend's cap, and it is not optional in
 * practice: `aggregate_groups` sorts largest-first and then APPENDS an `other`
 * band summing ranks `topN..`, keeping every individual row for the table. A
 * chart that stacks all of them plus `other` therefore draws the tail twice
 * and stands roughly `other` too tall. Slicing here to the first `topN`
 * aggregates plus `other` is exactly the composition the Rust doc describes,
 * and it sums to the same total the (unsliced) table reports. Omitted, every
 * band is drawn — correct only for a response with no `other` in it. */
export const groupBandsFor = (aggregates: GroupAggregate[], topN?: number): { key: string; values: number[] }[] => {
  // Sliced BEFORE the skill-group fold, on the backend's own ranking: `other`
  // sums the aggregates past the cap, so those are the ones that must go.
  const capped =
    topN === undefined || !aggregates.some((aggregate) => aggregate.key.kind === "other")
      ? aggregates
      : [
          ...aggregates.filter((aggregate) => aggregate.key.kind !== "other").slice(0, topN),
          ...aggregates.filter((aggregate) => aggregate.key.kind === "other"),
        ];

  const bands = new Map<string, number[]>();
  for (const { key, series } of capped) {
    const bandKey =
      key.kind === "player"
        ? `player:${key.index}`
        : key.kind === "enemySpawn"
          ? `target:${key.segment}`
          : key.kind === "enemyType"
            ? enemyRowKey(key.enemyType)
            : key.kind === "enemyAttack"
              ? `taken:${JSON.stringify({ enemyType: key.enemyType, actionId: key.actionId })}`
              : key.kind === "friendlyAbility"
                ? skillKey(abilityRowOf(key))
                : "other";
    const found = bands.get(bandKey);
    if (found) {
      for (let bucket = 0; bucket < series.length; bucket++) found[bucket] = (found[bucket] ?? 0) + series[bucket];
    } else {
      bands.set(bandKey, [...series]);
    }
  }
  return [...bands.entries()]
    .map(([key, values]) => ({ key, values, total: values.reduce((sum, value) => sum + value, 0) }))
    .sort((a, b) => {
      if (a.key === "other") return 1;
      if (b.key === "other") return -1;
      return b.total - a.total;
    })
    .map(({ key, values }) => ({ key, values }));
};
