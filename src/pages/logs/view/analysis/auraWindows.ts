import type { StatusInterval } from "@/types";

import type { Hostility } from "../metrics/types";
import type { Band } from "../statusBands";
import { statusPinKey } from "../statusUptime";
import { universeOf } from "./machine/resolve";
import type { WireWindow } from "./wireWindows";

/** Which holder an aura anchor resolved to — the pinned source/target in the
 * same universe-typed shape the group query's refs use (see `universeOf`). */
export type AuraHolder = { kind: "player"; index: number } | { kind: "enemySpawn"; segment: number };

/** The holder a pinned index names, under a dimension and a side.
 *
 * Which universe the pin names follows the hostility role-mapping, the same
 * rule the group query's refs use — so a source chip strip on the enemy side
 * is that SPAWN's effects, not a player's. Written once because the mask and
 * the chips that offer it must resolve the same pin to the same holder; two
 * spellings would let the strip show one actor's effects and the filter apply
 * another's. */
export const auraHolderFor = (dim: "source" | "target", hostility: Hostility, index: number): AuraHolder =>
  universeOf(dim, hostility) === "player" ? { kind: "player", index } : { kind: "enemySpawn", segment: index };

/** Whether one interval is HELD by a holder. A player holder matches by actor
 * index; an enemy holder by SPAWN segment — the game reissues a dead boss's
 * actor index, so the segment is the identity (the same reason `enemyHolderKey`
 * keys by it). */
export const heldBy = (interval: StatusInterval, holder: AuraHolder): boolean =>
  holder.kind === "player" ? interval.actorIndex === holder.index : interval.targetSegment === holder.segment;

/** The pinned holder's own windows of one effect. */
export const auraHolderIntervals = (
  intervals: StatusInterval[],
  pinKey: string,
  holder: AuraHolder
): StatusInterval[] => intervals.filter((interval) => statusPinKey(interval) === pinKey && heldBy(interval, holder));

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
