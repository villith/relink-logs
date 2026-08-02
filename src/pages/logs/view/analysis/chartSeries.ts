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
}): Record<string, number>[] => {
  const points: Record<string, number>[] = [];

  for (let bucket = 0; bucket < len; bucket++) {
    const point: Record<string, number> = {};

    for (const key of keys) {
      // An absent series is zero, not a missing key: the legend declares one
      // series per player, and a key the data lacks plots as a gap.
      const series = source[key] ?? [];
      const from = Math.max(0, bucket - smoothing + 1);
      let sum = 0;
      for (let i = from; i <= bucket; i++) sum += series[i] ?? 0;
      point[String(key)] = Math.round((sum / (bucket - from + 1)) * scale);
    }

    points.push(point);
  }

  return points;
};

