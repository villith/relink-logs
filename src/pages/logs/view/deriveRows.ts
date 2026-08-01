import type { SelectorPins } from "./selectorOptions";

/** What a row represents at the current pin state. */
export type RowLevel = "players" | "abilities" | "hits";

/**
 * The governing rule: rows are the most specific dimension still set to "All".
 *
 * Source and ability are *levels* — pinning one descends. Target is a *scope*:
 * it narrows which events count without changing what a row means, because
 * "damage to this enemy" is still asked per player.
 */
export const rowLevelFor = (pins: SelectorPins): RowLevel => {
  if (pins.ability !== null) return "hits";
  if (pins.source !== null) return "abilities";
  return "players";
};
