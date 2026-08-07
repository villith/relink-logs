/** A half-open span of fight time, `[startMs, endMs)`. Milliseconds relative to
 * whatever base the caller works in — the status pipeline and the chart both
 * count from the fight's start, the bands rebase onto a window afterwards. */
export type Span = { startMs: number; endMs: number };

/** Whether `span` covers any time inside `window`.
 *
 * Strict at BOTH ends, so a span that only touches an edge is not overlapping:
 * at zero width it contributes no time but would still draw a row, a band, or
 * an admitted bucket. Every clip in the pipeline follows this rule, which is
 * why it is spelled once. */
export const overlapsWindow = (span: Span, window: Span): boolean =>
  span.startMs < window.endMs && span.endMs > window.startMs;

/** `span` cropped to `window`, carrying every other field through untouched. */
export const clampToWindow = <T extends Span>(span: T, window: Span): T => ({
  ...span,
  startMs: Math.max(span.startMs, window.startMs),
  endMs: Math.min(span.endMs, window.endMs),
});

/** The spans overlapping `window`, each cropped to it.
 *
 * Input order is preserved — merging is the thing that needs a sort, and the
 * callers that only narrow (the status tables) would otherwise have their rows
 * silently reordered. */
export const clipSpans = <T extends Span>(spans: readonly T[], window: Span): T[] =>
  spans.filter((span) => overlapsWindow(span, window)).map((span) => clampToWindow(span, window));

/** Overlapping spans folded into a canonical non-overlapping list, sorted by
 * start.
 *
 * Adjacency-INCLUSIVE, unlike `overlapsWindow`: spans that meet exactly at a
 * boundary are one span, not two abutting ones. A buff resolves to 100% uptime
 * whether the log split it or not, and the chart draws one shading rather than
 * a seam.
 *
 * `combine` decides what the surviving span's PAYLOAD is when two fold
 * together; the merged bounds are the tool's own business and always win over
 * whatever it returns. By default the earlier span's payload stands, which is
 * what the callers carrying no payload want.
 *
 * The input is not mutated: every result is a fresh object, so a caller can
 * merge a list it does not own. */
export const mergeSpans = <T extends Span>(
  spans: readonly T[],
  combine: (into: T, span: T) => T = (into) => into
): T[] => {
  const merged: T[] = [];

  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs) {
      merged[merged.length - 1] = {
        ...combine(last, span),
        startMs: last.startMs,
        endMs: Math.max(last.endMs, span.endMs),
      };
    } else merged.push({ ...span });
  }

  return merged;
};
