/** One shaded span on the chart, in milliseconds from the START OF THE WINDOW —
 * which is what the chart's own first bucket is. */
export type Band = { startMs: number; endMs: number };

/** Status windows as spans the chart can draw, clamped to the visible window.
 *
 * Rebased onto the window rather than left at absolute fight time: a scrubbed
 * chart IS the window (the parent hands it data already cropped), so a band at
 * absolute time would sit wherever the scrub happened to begin.
 *
 * Spans in data space rather than percentages of the box: the plot is inset by
 * its y-axis, so a percentage overlay would mark a moment a few pixels away
 * from the data it is about. The chart draws these the same way the scope drag
 * draws its selection — a `<ReferenceArea>` in chart space — instead of adding
 * a second, differently-aligned shading mechanism.
 *
 * A band touching the window only at an edge is dropped: at zero width it would
 * draw as a hairline over a moment it never covered.
 */
export const toBands = (
  intervals: { startMs: number; endMs: number }[],
  { startMs, endMs }: { startMs: number; endMs: number }
): Band[] => {
  if (endMs <= startMs) return [];

  return intervals
    .filter((interval) => interval.startMs < endMs && interval.endMs > startMs)
    .map((interval) => ({
      startMs: Math.max(startMs, interval.startMs) - startMs,
      endMs: Math.min(endMs, interval.endMs) - startMs,
    }));
};
