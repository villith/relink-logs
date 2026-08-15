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
 * instant, so the `[startMs, endMs)` membership check alone already picks
 * the right spawn's window.
 *
 * Returns `null` only when the log carries no Overdrive/Break windows AT
 * ALL (an old log, or a fight with no mode transitions) — that is the one
 * case a real "neither mode" answer must not be confused with.
 */
export const modeInferenceForHit = (
  chartWindows: ChartWindow[],
  targetParentIndex: number,
  relTimeMs: number
): ModeInference | null => {
  const modeWindows = chartWindows.filter((window) => window.kind === "overdrive" || window.kind === "break");
  if (modeWindows.length === 0) return null;

  const covers = (kind: "overdrive" | "break"): boolean =>
    modeWindows.some(
      (window) =>
        window.kind === kind &&
        window.actorIndex === targetParentIndex &&
        relTimeMs >= window.startMs &&
        relTimeMs < window.endMs
    );

  return { overdrive: covers("overdrive"), break: covers("break") };
};
