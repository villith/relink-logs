import type { SelectorPins } from "./selectorOptions";

/** What a row represents at the current pin state.
 *
 * `"skills"` and not `"hits"`: the parser cannot produce per-hit rows, and this
 * level lists the pinned ability's MEMBER SKILLS — what a condensed group is
 * made of — so a name promising hits misleads.
 */
export type RowLevel = "players" | "abilities" | "skills";

/**
 * The governing rule: rows are the most specific dimension still set to "All".
 *
 * Source and ability are *levels* — pinning one descends. Target is a *scope*:
 * it narrows which events count without changing what a row means, because
 * "damage to this enemy" is still asked per player.
 *
 * An ability pinned with NO source still returns the deepest level: the ability
 * sets the level, and clearing the friendly only widens the scope to the whole
 * party (see `damageDone.rows`).
 */
export const rowLevelFor = (pins: SelectorPins): RowLevel => {
  if (pins.ability !== null) return "skills";
  if (pins.source !== null) return "abilities";
  return "players";
};

