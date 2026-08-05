import type { StatusInterval } from "@/types";

import { isStatusPin, statusPinKey, uptimeMs } from "../statusUptime";

/** One chart overlay band, ready to plot: a stable series key, the name the
 * legend shows, and one value per bucket — the shape the group bands and the
 * status stacks share, so the two overlays stay one branch at the call site. */
export type DrillSeries = { key: string; label: string; values: number[] };

/** One holder's stack count over the fight, one value per chart bucket. */
export type StatusSeries = DrillSeries;

/** Per-holder stack counts for the pinned effect, bucketed for the chart.
 *
 * This is the plot Warcraft Logs switches to when a buff is selected: one
 * series per holder, STACKED, so the height at any moment is how many stacks
 * the party held between them. Our chart previously did not change at all on a
 * status drill — the table dropped to holder rows beside a plot still drawing
 * whole-fight DPS.
 *
 * A stack count belongs on an axis rather than in a table cell: it varies
 * across a window, so a cell can only report the peak. The band shading over
 * the DPS plot (`bandOpacity`) says the same thing far more coarsely, and stays
 * for the effect rows, where there is no single holder to draw.
 *
 * Where one holder's windows OVERLAP the deeper stack wins rather than the sum:
 * two sources of one effect on one actor is one effect at whatever depth it
 * reached, exactly as `uptimeMs` merges rather than adds their durations.
 *
 * Holders are ranked by bucket coverage, longest first, so the deepest band
 * sits at the bottom of the stack and the plot does not reshuffle as the
 * pointer moves. */
export const buildStatusSeries = ({
  intervals,
  pinnedKey,
  bucketMs,
  len,
  holderOf,
}: {
  intervals: StatusInterval[];
  /** The pinned effect. A non-status pin (or none) yields no series at all —
   * the caller then keeps whatever chart it was already drawing. */
  pinnedKey: string | null;
  bucketMs: number;
  /** How many buckets the chart holds. */
  len: number;
  holderOf: (interval: StatusInterval) => { key: string; label: string };
}): StatusSeries[] => {
  if (!isStatusPin(pinnedKey) || len <= 0 || bucketMs <= 0) return [];

  const byHolder = new Map<string, StatusSeries>();

  for (const interval of intervals) {
    if (statusPinKey(interval) !== pinnedKey) continue;

    const { key, label } = holderOf(interval);
    let series = byHolder.get(key);
    if (!series) {
      series = { key, label, values: new Array<number>(len).fill(0) };
      byHolder.set(key, series);
    }

    // The hook reports 1 for every status `status.tbl` does not mark HasLevels,
    // so a missing or zero count is one stack rather than none — the same rule
    // `toBands` follows.
    const stacks = Math.max(1, interval.maxStacks);
    const first = Math.max(0, Math.floor(interval.startMs / bucketMs));
    // Inclusive of the bucket the window ends in, so a sub-bucket window still
    // colours the moment it happened rather than rounding away to nothing.
    const last = Math.min(len - 1, Math.floor((interval.endMs - 1) / bucketMs));

    for (let bucket = first; bucket <= last; bucket += 1) {
      series.values[bucket] = Math.max(series.values[bucket], stacks);
    }
  }

  // Coverage is counted ONCE per series and carried through the sort, for the
  // reason `byTotalDescending` spells out next door: a comparator that recounted
  // would allocate and walk two whole bucket arrays on every comparison.
  return [...byHolder.values()]
    .map((series) => ({ series, covered: series.values.reduce((n, value) => (value ? n + 1 : n), 0) }))
    .sort((a, b) => b.covered - a.covered)
    .map(({ series }) => series);
};

/** The TOP-LEVEL aura chart: one series per effect (the top `topN` by merged
 * uptime, the same ranking the table's effect rows sort by), Y = how many
 * holders had the effect active in that bucket.
 *
 * This is what makes the machine's `chart:"stacks"` declaration true with no
 * effect pinned — the analog of Warcraft Logs' pre-selection buff overview,
 * drawn from the effects themselves rather than WCL's raid-damage context
 * chart. Pinning an effect switches to `buildStatusSeries`' per-holder stack
 * counts, one level down.
 *
 * A holder is counted ONCE per bucket however many of their windows overlap
 * it — the same merge rule `uptimeMs` applies to durations. Effects are keyed
 * by `statusPinKey` (effect AND cause), so the series decompose exactly as the
 * table's rows do. */
export const buildEffectSeries = ({
  intervals,
  bucketMs,
  len,
  topN,
  labelOf,
  holderKeyOf,
}: {
  /** Already narrowed to one side and polarity — the caller applies the same
   * roster/`isHarmful` split the table rows use. */
  intervals: StatusInterval[];
  bucketMs: number;
  /** How many buckets the chart holds. */
  len: number;
  topN: number;
  labelOf: (key: string) => string;
  /** What a distinct holder IS — a player index on the friendly side, a spawn
   * on the enemy side (`enemyHolderKey`). */
  holderKeyOf: (interval: StatusInterval) => string;
}): DrillSeries[] => {
  if (len <= 0 || bucketMs <= 0) return [];

  const byEffect = new Map<string, StatusInterval[]>();
  for (const interval of intervals) {
    const key = statusPinKey(interval);
    const group = byEffect.get(key);
    if (group) group.push(interval);
    else byEffect.set(key, [interval]);
  }

  return [...byEffect.entries()]
    .map(([key, group]) => ({ key, group, uptime: uptimeMs(group) }))
    .sort((a, b) => b.uptime - a.uptime)
    .slice(0, topN)
    .map(({ key, group }) => {
      // Presence per (holder, bucket) first, so overlapping windows of one
      // holder cannot count them twice.
      const coveredByHolder = new Map<string, Uint8Array>();
      for (const interval of group) {
        const holder = holderKeyOf(interval);
        let covered = coveredByHolder.get(holder);
        if (!covered) {
          covered = new Uint8Array(len);
          coveredByHolder.set(holder, covered);
        }
        // `covered` is a Uint8Array, which silently drops writes at negative
        // or out-of-range indices anyway, so these clamps do NOT protect
        // `values` — the written bucket set is the same either way. What they
        // actually bound is the loop's iteration count: without Math.max, a
        // sufficiently negative startMs walks from a huge negative `first` up
        // to `last`, one iteration per bucket that never lands. Don't drop
        // them as dead defensive code.
        const first = Math.max(0, Math.floor(interval.startMs / bucketMs));
        // Inclusive of the bucket the window ends in — the same sub-bucket
        // rule buildStatusSeries applies.
        const last = Math.min(len - 1, Math.floor((interval.endMs - 1) / bucketMs));
        for (let bucket = first; bucket <= last; bucket += 1) covered[bucket] = 1;
      }

      const values = new Array<number>(len).fill(0);
      for (const covered of coveredByHolder.values()) {
        for (let bucket = 0; bucket < len; bucket += 1) values[bucket] += covered[bucket];
      }
      return { key, label: labelOf(key), values };
    });
};
