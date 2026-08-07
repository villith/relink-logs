import { clipSpans, mergeSpans } from "./spans";

/** One shaded span on the chart, in milliseconds from the START OF THE WINDOW —
 * which is what the chart's own first bucket is.
 *
 * `stacks` is the PEAK the effect reached anywhere inside the span, which is
 * the only honest number a merged band can carry: it already spans every holder
 * and every refresh, so there is no single stack count to report. Warcraft Logs
 * shows the real curve instead, one area series per holder with stacks as the
 * y-value — that needs a chart of its own, not a shading over the DPS plot. */
export type Band = { startMs: number; endMs: number; stacks: number };

/** Shading for a one-stack band — what every band drew before stacks existed,
 * and what the ~100 unstackable statuses still draw. */
export const BAND_BASE_OPACITY = 0.16;

/** Ceiling on a band's shading. The band is a backdrop for the DPS lines, and
 * past this it stops reading as shading and starts hiding them. */
export const BAND_MAX_OPACITY = 0.4;

/** Added per stack above the first. */
const BAND_OPACITY_PER_STACK = 0.05;

/** How strongly to shade a band holding `stacks` of an effect.
 *
 * This is where a stack count reaches the chart. Warcraft Logs draws the real
 * curve — one area series per holder, stacks on the y-axis — which needs its own
 * plot; over a DPS chart the honest analogue is that a deeper stack shades
 * harder. Counts at or below zero shade as one: the hook reports 1 for every
 * status `status.tbl` does not mark `HasLevels`, so "no count" is one stack,
 * never none. */
export const bandOpacity = (stacks: number): number =>
  Math.min(BAND_MAX_OPACITY, BAND_BASE_OPACITY + Math.max(0, stacks - 1) * BAND_OPACITY_PER_STACK);

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
 *
 * Overlaps are MERGED. One effect row covers every holder and every refresh, so
 * a party-wide buff on a long fight produced hundreds of identical, stacked
 * spans — each a mounted `<ReferenceArea>` redrawn on every tooltip hover, all
 * painting the same region several deep at the same opacity. The merged form
 * draws the same picture out of the few spans it actually has.
 */
export const toBands = (
  intervals: { startMs: number; endMs: number; maxStacks?: number }[],
  { startMs, endMs }: { startMs: number; endMs: number }
): Band[] => {
  if (endMs <= startMs) return [];

  const clipped: Band[] = clipSpans(intervals, { startMs, endMs }).map((interval) => ({
    startMs: interval.startMs - startMs,
    endMs: interval.endMs - startMs,
    // The hook reports 1 for every status status.tbl does not mark
    // HasLevels, so a missing count is one stack rather than none.
    stacks: interval.maxStacks ?? 1,
  }));

  return mergeSpans(clipped, (into, span) => ({ ...into, stacks: Math.max(into.stacks, span.stacks) }));
};
