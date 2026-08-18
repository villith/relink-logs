import type { ModeInference } from "@/pages/logs/view/events/damageExplain";
import type { ChartWindow } from "@/types";

/**
 * Joins one hit against the fight's Overdrive/Break chart windows: is the
 * hit's target inside one of them at the hit's own moment?
 *
 * `chartWindows[].actorIndex` is the enemy's own actor index — the SAME
 * field `EnemyMode`/`TargetSegment` name an enemy by (`target.parent_index`
 * on a damage event), and NOT the folded instance pointer `CapDebugHit`'s
 * `targetIndex` carries. Callers must join on `targetParentIndex`, mirroring
 * how the analysis view's `breakEnemyOf`/`enemyTypeAt` resolve a window's
 * actor index against an enemy.
 *
 * `relTimeMs` and `window.startMs/endMs` already share one clock: both
 * `fetch_encounter_events`' row timestamps and `fetch_encounter_state`'s
 * chart windows are rebased against `Parser::start_time()` (the first event
 * in the log) server-side, so no further rebasing happens here.
 *
 * Actor-index reuse (the game reissuing a dead boss's id to a later spawn)
 * needs no extra disambiguation here the way `breakEnemyOf`'s DISPLAY lookup
 * does: two windows sharing one actor index can never both cover the same
 * instant (see the end-bound note below for the one moment they touch), so
 * the membership check alone already picks the right spawn's window.
 *
 * Returns `null` only when the log carries no Overdrive/Break windows AT
 * ALL (an old log, or a fight with no mode transitions) — that is the one
 * case a real "neither mode" answer must not be confused with.
 *
 * The end bound is exclusive EXCEPT at a window a fight-end close artificially
 * cut off: `assemble_chart_windows` (Rust) closes a window still open at the
 * last event at `fight_end_ms` — the LAST event's own timestamp, not one past
 * it — so a hit that IS the last event lands exactly at `endMs`. Reading that
 * as outside the window would misreport the killing blow landing while an
 * enemy sits in Break as "not in Break". A real hand-off is not fooled by
 * this: when another mode window for the SAME actor genuinely starts at that
 * exact millisecond (a transition, not an artificial close), that later
 * window is what actually held at that instant and wins.
 */
export const modeInferenceForHit = (
  chartWindows: ChartWindow[],
  targetParentIndex: number,
  relTimeMs: number
): ModeInference | null => {
  const modeWindows = chartWindows.filter((window) => window.kind === "overdrive" || window.kind === "break");
  if (modeWindows.length === 0) return null;

  // Whether some other window for this actor picks up exactly where `window`
  // ends — a real transition, as opposed to an artificial fight-end close.
  const handedOff = (window: ChartWindow): boolean =>
    modeWindows.some(
      (next) => next !== window && next.actorIndex === targetParentIndex && next.startMs === window.endMs
    );

  const covers = (kind: "overdrive" | "break"): boolean =>
    modeWindows.some((window) => {
      if (window.kind !== kind || window.actorIndex !== targetParentIndex) return false;
      if (relTimeMs < window.startMs || relTimeMs > window.endMs) return false;
      if (relTimeMs < window.endMs) return true;
      // relTimeMs === window.endMs.
      return !handedOff(window);
    });

  return { overdrive: covers("overdrive"), break: covers("break") };
};
