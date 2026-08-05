import type { StatusInterval } from "@/types";

import type { Band } from "../statusBands";
import { clipToWindow, statusPinKey } from "../statusUptime";

/** Which holder an aura anchor resolved to — the pinned source/target in the
 * same universe-typed shape the group query's refs use (see `universeOf`). */
export type AuraHolder = { kind: "player"; index: number } | { kind: "enemySpawn"; segment: number };

/** One span of the wire mask, ms relative to the FIGHT's start (the same base
 * the aggregator's `rel_ts` is) — start-inclusive, end-exclusive, the status
 * pipeline's own edge convention. */
export type WireWindow = { fromMs: number; upToMs: number };

/** The pinned holder's own windows of one effect. A player holder matches by
 * actor index; an enemy holder by SPAWN segment — the game reissues a dead
 * boss's actor index, so the segment is the identity (the same reason
 * `enemyHolderKey` keys by it). */
export const auraHolderIntervals = (
  intervals: StatusInterval[],
  pinKey: string,
  holder: AuraHolder
): StatusInterval[] =>
  intervals.filter(
    (interval) =>
      statusPinKey(interval) === pinKey &&
      (holder.kind === "player" ? interval.actorIndex === holder.index : interval.targetSegment === holder.segment)
  );

/** The wire mask: the holder's windows clipped to the chart window and
 * merged. `clipToWindow` already drops zero-width edge touches, so the mask
 * follows the `[startMs, endMs)` convention end to end. Empty is a REAL
 * answer (the effect was never up inside the window) and the aggregator
 * masks everything for it — narrowing, never widening. */
export const auraWireWindows = (
  intervals: StatusInterval[],
  window: { startMs: number; endMs: number }
): WireWindow[] => {
  const clipped = clipToWindow(intervals, window.startMs, window.endMs).sort((a, b) => a.startMs - b.startMs);
  const merged: WireWindow[] = [];
  for (const interval of clipped) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.upToMs) last.upToMs = Math.max(last.upToMs, interval.endMs);
    else merged.push({ fromMs: interval.startMs, upToMs: interval.endMs });
  }
  return merged;
};

/** The EXCLUDED regions — the chart window minus the mask — as chart bands
 * (rebased onto the window's start, exactly like `toBands`). The data drawn
 * IS the kept part, so the shading marks what the filter removed: the
 * existing band mechanism, inverted. `windows` must be sorted and merged,
 * which is what `auraWireWindows` returns. */
export const auraExcludedBands = (windows: WireWindow[], window: { startMs: number; endMs: number }): Band[] => {
  const bands: Band[] = [];
  let cursor = window.startMs;
  for (const span of windows) {
    if (span.fromMs > cursor) {
      bands.push({ startMs: cursor - window.startMs, endMs: span.fromMs - window.startMs, stacks: 1 });
    }
    cursor = Math.max(cursor, span.upToMs);
  }
  if (cursor < window.endMs) {
    bands.push({ startMs: cursor - window.startMs, endMs: window.endMs - window.startMs, stacks: 1 });
  }
  return bands;
};
