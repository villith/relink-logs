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
   * edge (the decay tail reads as damage after a window filter's end) and
   * dilute the first buckets inside it with the excluded zeros — so masked
   * buckets plot as zero and the average divides by admitted buckets only. */
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
      let count = 0;
      for (let i = from; i <= bucket; i++) {
        if (admitted !== undefined && !admitted[i]) continue;
        sum += series[i] ?? 0;
        count += 1;
      }
      point[String(key)] = masked || count === 0 ? 0 : Math.round((sum / count) * scale);
    }

    points.push(point);
  }

  return points;
};

/** The Total series' key. A reserved word rather than a player index or a
 * row-key grammar, so it can never collide with a real series. */
export const TOTAL_SERIES_KEY = "total";

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
