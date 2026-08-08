import { TOTAL_KEY } from "../rowKey";

/** Turns a metric's bucketed per-player series into chart datapoints.
 *
 * Extracted from the view because the three metrics differ in more than their
 * source: DPS is a rate and is smoothed, the SBA gauge is a level stored in
 * tenths of a percent and must not be, and their bucket counts differ. Keeping
 * the shaping here means adding a metric is adding a descriptor, not a branch.
 *
 * Points are keyed by SERIES KEY, never by display label — an actor index at the
 * players level, a group or spawn key when drilled in. Two players can share a
 * label ("AI"), and a label-keyed point silently overwrites one with the other. */
export const buildSeriesPoints = ({
  source,
  len,
  keys,
  smoothing,
  scale,
  admitted,
}: {
  /** Bucketed values keyed by series key. */
  source: Record<string, number[]>;
  /** How many buckets this metric spans. */
  len: number;
  /** Every series to plot, whether or not this metric has data for it. */
  keys: (string | number)[];
  /** Trailing moving-average window in buckets; 1 leaves values untouched. */
  smoothing: number;
  /** Multiplier for the stored value (the SBA gauge is stored in tenths). */
  scale: number;
  /** Which buckets a filter mask admits; absent = all. A trailing average
   * over a masked series would otherwise smear its spikes past the mask's
   * edge — the decay tail reads as damage after a window filter's end — so a
   * masked bucket plots as zero outright.
   *
   * The excluded buckets keep their PLACE in the trailing window even though
   * their values are dropped. The Y axis is a rate per bucket of wall clock,
   * and dividing by the admitted count instead would rescale it to a rate per
   * admitted bucket: at the leading edge of an admitted region, where only one
   * of `smoothing` buckets is admitted, the same damage would plot up to
   * `smoothing`× higher. A filter that removes TIME but no damage would then
   * raise the line above its unfiltered self (log #1880: an aura excluding
   * 0.13% of the damage doubled the plotted peak and moved the fight's
   * maximum), and the area under the chart would stop matching the table it
   * sits above. The cost is the honest one: the line ramps in over the
   * smoothing period at each admitted region's start, because that is how much
   * wall clock the average has actually seen. */
  admitted?: boolean[];
}): Record<string, number>[] => {
  const points: Record<string, number>[] = [];

  for (let bucket = 0; bucket < len; bucket++) {
    const point: Record<string, number> = {};
    // A masked bucket plots zero outright — its trailing window still holds
    // admitted spikes, and averaging them here IS the smear past the edge.
    const masked = admitted !== undefined && !admitted[bucket];

    for (const key of keys) {
      // An absent series is zero, not a missing key: the legend declares one
      // series per player, and a key the data lacks plots as a gap.
      const series = source[key] ?? [];
      const from = Math.max(0, bucket - smoothing + 1);
      let sum = 0;
      for (let i = from; i <= bucket; i++) {
        // Excluded buckets contribute nothing to the sum but still count in the
        // denominator below — see `admitted`.
        if (admitted !== undefined && !admitted[i]) continue;
        sum += series[i] ?? 0;
      }
      // The window's own length, which at the fight's start is short of
      // `smoothing`: there are no buckets behind bucket 0 to average over.
      point[String(key)] = masked ? 0 : Math.round((sum / (bucket - from + 1)) * scale);
    }

    points.push(point);
  }

  return points;
};

/** The Total series' key: the row-key grammar's reserved word for the total,
 * so the series and the ref `rowRefOf` resolves are one identity. */
export const TOTAL_SERIES_KEY = TOTAL_KEY;

/** Adds a Total value to every point: the sum of ALL listed series, whatever
 * the legend later hides — Warcraft Logs' Total likewise ignores legend state.
 * Summing the already-smoothed points is exact: a trailing moving average is
 * linear, so the sum of the smoothed series IS the smoothed sum. */
export const withTotalSeries = (
  points: Record<string, number>[],
  keys: (string | number)[]
): Record<string, number>[] =>
  points.map((point) => ({
    ...point,
    [TOTAL_SERIES_KEY]: keys.reduce((sum: number, key) => sum + (point[String(key)] ?? 0), 0),
  }));
