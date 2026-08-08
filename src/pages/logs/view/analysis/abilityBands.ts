import type { AbilitySeries } from "@/types";

import { abilityKey, skillKey } from "../abilityKey";
import { abilityRowKey, type RowKeying } from "../abilitySkills";
import type { DrillSeries } from "./statusChart";

/** The backend's per-breakdown-row bands folded into the table's ability ROWS.
 *
 * The parser cannot produce these keys and deliberately does not try:
 * `abilityRowKey` folds through `skillGroupFor`, the display skill-grouping
 * table, and `actionsForPin` states the intent — the expansion comes from what
 * the party actually used rather than from the group table, which "keeps the
 * parser free of a display concern it has never known about". So the backend
 * emits one band per breakdown row and the fold happens here, with the SAME
 * function the table folds `skillBreakdown` with. A band and the row it
 * decomposes therefore agree by construction rather than by coincidence.
 *
 * Cause bands (SBA's non-hit causes and its unattributed remainder) carry their
 * row key already — they have no action to group by — so they pass through.
 *
 * Ranked like the group bands, and capped the same way: `topN` MARKS the bands
 * past the cap as `tail` rather than removing them. The chart draws the tail
 * hidden and rolls it up itself, from whichever tail bands are still hidden
 * (see `chartRollup`) — summed into one `other` band here, the tail had no
 * series of its own left and could never be switched back on.
 *
 * `foldBy` mirrors the table's own two folds. "group" is `groupSkillsForRows`,
 * the default. "action" is `mergeSkillsByAction` — used once a group is PINNED,
 * where the rows are that group's members and folding them back would redraw
 * the single band that was just clicked. Like that fold, it drops the child
 * character deliberately: a player and their summon on one action id are one
 * member skill, not two. */
export const abilityBands = (
  series: AbilitySeries[],
  topN: number,
  labelOf: (key: string) => string,
  foldBy: "group" | "action" = "group",
  keying?: RowKeying
): DrillSeries[] => {
  if (series.length === 0) return [];

  // The longest series is authoritative: a band that accrued nothing late can
  // arrive short, and recharts reads a missing tail as a gap rather than zero.
  const len = Math.max(0, ...series.map((band) => band.values.length));

  const byRow = new Map<string, number[]>();
  for (const band of series) {
    // `skillKey`, not the bare row key: band keys are namespaced, and a bare
    // one falls through `bandLabelFor` to print itself. A cause band already
    // carries a full row key (`source:…`, `skill:unattributed`).
    const key =
      band.kind === "cause"
        ? band.key
        : skillKey(foldBy === "action" ? abilityKey(band.actionType) : abilityRowKey(band, keying));
    const values = byRow.get(key) ?? new Array<number>(len).fill(0);
    for (let bucket = 0; bucket < len; bucket++) values[bucket] += band.values[bucket] ?? 0;
    byRow.set(key, values);
  }

  const ranked = [...byRow.entries()]
    .map(([key, values]) => ({ key, values, total: values.reduce((sum, value) => sum + value, 0) }))
    .sort((a, b) => b.total - a.total);

  return ranked.map(({ key, values }, rank) => ({
    key,
    label: labelOf(key),
    values,
    ...(rank >= topN ? { tail: true } : {}),
  }));
};
