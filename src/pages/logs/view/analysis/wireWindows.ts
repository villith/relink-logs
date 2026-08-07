/** One span of the wire mask, ms relative to the FIGHT's start (the same base
 * the aggregator's `rel_ts` is) — start-inclusive, end-exclusive, the status
 * pipeline's own edge convention. */
export type WireWindow = { fromMs: number; upToMs: number };

/** A wire mask built from arbitrary spans: clipped to the window, sorted by
 * start, and merged into a canonical non-overlapping list.
 *
 * The aura filter (a holder's status intervals) and the window filter (the
 * selected battle windows) both reduce to exactly this, and their results are
 * intersected and handed to the same aggregator — so they have to agree on
 * every edge rule. One function rather than two is what keeps them agreeing;
 * two copies of a merge loop is precisely the thing that drifts.
 *
 * Overlap is tested strictly at both ends, so a span that only TOUCHES an edge
 * is dropped: at zero width it contributes no time but would still draw a row.
 * Merging, by contrast, is adjacency-inclusive — spans that meet exactly at a
 * boundary are one span, not two abutting ones.
 *
 * Empty is a REAL answer rather than "no filter applied": it means nothing was
 * admitted, and the aggregator masks everything for it. Narrowing, never
 * widening.
 */
export const wireWindowsFrom = (
  spans: readonly { startMs: number; endMs: number }[],
  window: { startMs: number; endMs: number }
): WireWindow[] => {
  const clipped = spans
    .filter((span) => span.startMs < window.endMs && span.endMs > window.startMs)
    .map((span) => ({
      fromMs: Math.max(span.startMs, window.startMs),
      upToMs: Math.min(span.endMs, window.endMs),
    }))
    .sort((a, b) => a.fromMs - b.fromMs);

  const merged: WireWindow[] = [];
  for (const span of clipped) {
    const last = merged[merged.length - 1];
    if (last && span.fromMs <= last.upToMs) last.upToMs = Math.max(last.upToMs, span.upToMs);
    else merged.push({ ...span });
  }
  return merged;
};
