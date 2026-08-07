import type { StatusInterval } from "@/types";

import type { Band } from "../statusBands";
import { statusPinKey } from "../statusUptime";
import type { WireWindow } from "./wireWindows";

/** Which holder an aura anchor resolved to — the pinned source/target in the
 * same universe-typed shape the group query's refs use (see `universeOf`). */
export type AuraHolder = { kind: "player"; index: number } | { kind: "enemySpawn"; segment: number };

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

/** The EXCLUDED regions — the chart window minus the mask — as chart bands
 * (rebased onto the window's start, exactly like `toBands`). The data drawn
 * IS the kept part, so the shading marks what the filter removed: the
 * existing band mechanism, inverted. `windows` must be sorted and merged,
 * which is what `wireWindowsFrom` returns. */
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
