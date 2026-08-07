import type { EventRow } from "../events/eventRows";
import type { MetricRow } from "../metrics/types";
import type { Span } from "../spans";

import type { LaneMatcher } from "./laneMatch";

/** One drawn mark. Times are milliseconds FROM THE START OF THE WINDOW, the
 * same base `MetricRow.timeline` uses — so a status bar and a damage tick on
 * one screen measure from one origin.
 *
 * A mark of zero width is an instant (one hit). A wider one is either a real
 * span (a status row) or several instants folded because they would have
 * overlapped at the current scale; `Lane.spans` says which. */
export type LaneMark = {
  startMs: number;
  endMs: number;
  /** How many events are behind this mark. Always 1 for a real span. */
  count: number;
  /** Their summed amount, or null when none of them carried one — a stun or a
   * death has no amount, and reporting 0 would read as a measured zero. */
  amount: number | null;
};

/** One table row plus what it draws. */
export type Lane = {
  row: MetricRow;
  marks: LaneMark[];
  /** True when the marks are REAL spans off the row's own `timeline`, false
   * when they are instants folded by pixel density. The hover card branches on
   * this: a span reports a duration, a fold reports a count. */
  spans: boolean;
};

/** The gap, in milliseconds, below which two marks would collide on screen.
 *
 * Derived from the measured container so it tracks the real scale rather than
 * an assumed one. Zero before the container has been measured, which merges
 * nothing — the safe direction, since the alternative divides by zero and
 * folds every lane into a single mark. */
export const markGapMs = ({
  widthPx,
  viewportMs,
  gapPx,
}: {
  widthPx: number;
  viewportMs: number;
  gapPx: number;
}): number => (widthPx <= 0 ? 0 : (gapPx * viewportMs) / widthPx);

/** Every event filed under the lane that claims it, in ONE pass.
 *
 * Events outside the window are dropped rather than clamped: an instant
 * clamped to the edge would draw a mark at a time it did not happen. */
export const marksByLane = (events: EventRow[], matcher: LaneMatcher, window: Span): Map<string, LaneMark[]> => {
  const byLane = new Map<string, LaneMark[]>();

  for (const event of events) {
    if (event.timeMs < window.startMs || event.timeMs > window.endMs) continue;
    const lane = matcher.laneOf(event);
    if (lane === null) continue;

    const at = event.timeMs - window.startMs;
    const mark: LaneMark = { startMs: at, endMs: at, count: 1, amount: event.amount };
    const found = byLane.get(lane);
    if (found) found.push(mark);
    else byLane.set(lane, [mark]);
  }

  return byLane;
};

/** Marks folded so that none of them would overlap on screen.
 *
 * Sorted first, so the fold cannot depend on the order events arrived in.
 * `null + null` stays null while `null + n` becomes n: a lane where nothing
 * carried an amount must keep saying so. */
export const mergeMarks = (marks: LaneMark[], gapMs: number): LaneMark[] => {
  const merged: LaneMark[] = [];

  for (const mark of [...marks].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && mark.startMs - last.endMs <= gapMs) {
      last.endMs = Math.max(last.endMs, mark.endMs);
      last.count += mark.count;
      last.amount = last.amount === null ? mark.amount : last.amount + (mark.amount ?? 0);
    } else {
      merged.push({ ...mark });
    }
  }

  return merged;
};

/** The lanes, in the rows' own order.
 *
 * EVERY row becomes a lane, including one with nothing to draw. Dropping the
 * empty ones would leave the timeline and the table disagreeing about which
 * rows the fight has — and the empty lane is itself the finding on a metric
 * whose events carry no action id to place (stun, grouped by ability). */
export const lanesFor = (rows: MetricRow[], byLane: Map<string, LaneMark[]>, gapMs: number): Lane[] =>
  rows.map((row) => {
    if (row.timeline !== undefined) {
      return {
        row,
        spans: true,
        marks: row.timeline.map((span) => ({ startMs: span.startMs, endMs: span.endMs, count: 1, amount: null })),
      };
    }
    return { row, spans: false, marks: mergeMarks(byLane.get(row.key) ?? [], gapMs) };
  });
