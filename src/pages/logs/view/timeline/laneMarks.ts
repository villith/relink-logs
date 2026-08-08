import { SUPPLEMENTARY_KEY, supplementaryCause } from "../abilityKey";
import type { EventRow } from "../events/eventRows";
import type { MetricRow } from "../metrics/types";
import type { Span } from "../spans";

import { castKeyOf } from "./castKey";
import type { LaneMatcher } from "./laneMatch";

/** One action's share of a mark. `amount` is 0 rather than null for a kind
 * that carries none (a stun, a death, an effect landing): these are summed and
 * sorted, and a null in that arithmetic would poison the fold. The mark's own
 * `amount` still says null when nothing carried one. */
export type MarkPart = { key: string; count: number; amount: number };

/** One event inside a mark, at its real time. `echo` splits the tick colour so
 * supplementary damage reads as part of the cast but plainly not the skill's
 * own swing — the timeline's half of `MetricBar`'s fainter segment. */
export type MarkHit = { atMs: number; echo: boolean };

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
  /** What produced this mark, folded by action (or effect) and sorted by
   * amount descending — the order the breakdown card lists them in.
   *
   * Empty for a real span: a status row's `timeline` is not an event fold and
   * has no parts to name. */
  by: MarkPart[];
  /** Every event behind this mark, at its real time — what the internal ticks
   * draw. Empty for a real span, which is not an event fold. */
  hits: MarkHit[];
  /** How many CASTS folded in. 1 until the density fold merges two, which is
   * what lets a merged mark say "2 casts" rather than claim one. */
  casts: number;
  /** The cast identity every event in this mark shares, or "" once the density
   * fold has merged marks that do not share one. */
  castKey: string;
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
 * clamped to the edge would draw a mark at a time it did not happen.
 *
 * The window is HALF-OPEN, `[startMs, endMs)`, which is the rule the whole
 * pipeline already follows: `statusWindow.endMs` is `(lastBucket + 1) * 1000`
 * — the first millisecond of the bucket AFTER the window — and the group query
 * admits only up to `endMs - 1` (see `wireQuery`'s `upToMs`). An inclusive end
 * here would draw a mark for a hit the table's own numbers exclude, which is
 * the one thing a timeline drawn beside that table must never do. */
export const marksByLane = (
  events: EventRow[],
  matcher: LaneMatcher,
  window: Span,
  collapseEchoes = false
): Map<string, LaneMark[]> => {
  const byLane = new Map<string, LaneMark[]>();

  for (const event of events) {
    if (event.timeMs < window.startMs || event.timeMs >= window.endMs) continue;
    const lane = matcher.laneOf(event);
    if (lane === null) continue;

    const at = event.timeMs - window.startMs;
    const echo = event.abilityKey !== null && supplementaryCause(event.abilityKey) !== null;
    // The echo's part key normalises to the FOLDED key, the same one the table
    // folds its echo row onto. Keyed raw, each distinct SupplementaryDamage(n)
    // is its own part and the breakdown card lists nine rows all reading
    // "Supplementary Damage" — the defect the fold fixed at the table level,
    // reappearing here.
    const partKey = echo ? SUPPLEMENTARY_KEY : event.abilityKey ?? event.statusKey ?? "";
    const mark: LaneMark = {
      startMs: at,
      endMs: at,
      count: 1,
      amount: event.amount,
      by: [{ key: partKey, count: 1, amount: event.amount ?? 0 }],
      hits: [{ atMs: at, echo }],
      casts: 1,
      castKey: castKeyOf(event, collapseEchoes),
    };
    const found = byLane.get(lane);
    if (found) found.push(mark);
    else byLane.set(lane, [mark]);
  }

  return byLane;
};

/** Two part lists summed by key, largest first. Sorted here rather than at the
 * card, so the card stays a renderer and the ordering rule has one home. */
const foldParts = (into: MarkPart[], parts: MarkPart[]): MarkPart[] => {
  const byKey = new Map<string, MarkPart>();
  for (const part of [...into, ...parts]) {
    const found = byKey.get(part.key);
    if (found) {
      found.count += part.count;
      found.amount += part.amount;
    } else byKey.set(part.key, { ...part });
  }
  return [...byKey.values()].sort((a, b) => b.amount - a.amount);
};

/** The idle gap that ends a cast.
 *
 * A fixed figure, deliberately NOT derived from the zoom: a cast that splits
 * when you zoom in is the exact thing that made this view hard to read. */
export const CAST_GAP_MS = 1000;

/** The longest a cast may grow.
 *
 * Without a ceiling, a lane whose events recur inside the gap forever — a
 * continuously attacking player's auto-attacks, or a poison ticking once a
 * second for thirty — chains the whole fight into a single "cast". */
export const CAST_MAX_MS = 6000;

/** Adjacent marks folded into runs, by whatever `joins` says a run is.
 *
 * The two folds below differ ONLY in that predicate and in what the cast count
 * does — the accumulation (extend the end, sum the count and the amount, fold
 * the parts, concatenate the hits) is one rule at both grains, and it was worth
 * writing once: an amount summed one way by the cast fold and another by the
 * density fold is a mark whose tooltip does not add up to its own bar.
 *
 * Sorted first, so neither fold can depend on the order events arrived in.
 * `null + null` stays null while `null + n` becomes n: a lane where nothing
 * carried an amount must keep saying so. */
const foldRuns = (
  marks: LaneMark[],
  joins: (last: LaneMark, next: LaneMark) => boolean,
  onJoin?: (last: LaneMark, next: LaneMark) => void
): LaneMark[] => {
  const merged: LaneMark[] = [];

  for (const mark of [...marks].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last === undefined || !joins(last, mark)) {
      merged.push({ ...mark, by: [...mark.by], hits: [...mark.hits] });
      continue;
    }
    last.endMs = Math.max(last.endMs, mark.endMs);
    last.count += mark.count;
    last.amount = last.amount === null ? mark.amount : last.amount + (mark.amount ?? 0);
    last.by = foldParts(last.by, mark.by);
    last.hits = [...last.hits, ...mark.hits];
    onJoin?.(last, mark);
  }

  return merged;
};

/** Marks folded into casts: same identity, inside the idle gap, bounded by the
 * ceiling.
 *
 * Runs BEFORE `mergeMarks`, so what counts as one cast is settled before the
 * screen has any say in it. */
export const mergeCasts = (marks: LaneMark[]): LaneMark[] =>
  foldRuns(
    marks,
    (last, next) =>
      last.castKey === next.castKey &&
      next.startMs - last.endMs <= CAST_GAP_MS &&
      next.endMs - last.startMs <= CAST_MAX_MS
  );

/** Marks folded so that none of them would overlap on screen. */
export const mergeMarks = (marks: LaneMark[], gapMs: number): LaneMark[] =>
  foldRuns(
    marks,
    (last, next) => next.startMs - last.endMs <= gapMs,
    (last, next) => {
      last.casts += next.casts;
      // Two folded marks no longer share one identity, and claiming either
      // one's would name the mark after half of what it holds.
      if (last.castKey !== next.castKey) last.castKey = "";
    }
  );

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
        marks: row.timeline.map((span) => ({
          startMs: span.startMs,
          endMs: span.endMs,
          count: 1,
          amount: null,
          by: [],
          hits: [],
          casts: 1,
          castKey: "",
        })),
      };
    }
    // Casts first, then the screen: the fold that MEANS something must not
    // depend on the one that is only about pixels.
    return { row, spans: false, marks: mergeMarks(mergeCasts(byLane.get(row.key) ?? []), gapMs) };
  });
