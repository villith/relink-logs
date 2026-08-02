import type { StatusInterval } from "@/types";

import { isStatusPin, statusPinKey } from "../statusUptime";

/** One holder's stack count over the fight, one value per chart bucket. */
export type StatusSeries = { key: string; label: string; values: number[] };

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

  return [...byHolder.values()].sort((a, b) => b.values.filter(Boolean).length - a.values.filter(Boolean).length);
};

