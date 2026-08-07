import { clipSpans, mergeSpans } from "../spans";

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
 * The edge rules are `clipSpans`/`mergeSpans`': overlap is tested strictly, so
 * a span that only TOUCHES the window is dropped, while merging is
 * adjacency-inclusive so spans meeting exactly at a boundary become one. The
 * status uptime, band and mask helpers read the same primitive, which is what
 * stops any of them disagreeing about where a millisecond falls.
 *
 * Empty is a REAL answer rather than "no filter applied": it means nothing was
 * admitted, and the aggregator masks everything for it. Narrowing, never
 * widening.
 */
export const wireWindowsFrom = (
  spans: readonly { startMs: number; endMs: number }[],
  window: { startMs: number; endMs: number }
): WireWindow[] =>
  mergeSpans(clipSpans(spans, window)).map(({ startMs, endMs }) => ({ fromMs: startMs, upToMs: endMs }));
