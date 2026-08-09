import boardSources from "@/assets/skillboard-cap-sources.json";

import type { CapLoadout } from "../capSources";
import { activeResult, unknownResult, type CapFactor } from "./types";

/**
 * The account-wide cap-up terms — the ones that come from progression rather
 * than from anything equipped.
 *
 * The master trait RANK bonus is derived here. The rest of the Masteries screen
 * (the AP trees, which the game's UI labels Offense / Defense / Collection) is
 * valued exactly in the game's tables but its input — which tree nodes a player
 * unlocked — is not on the log, so it stays named and unresolved until a hook
 * capture exists.
 *
 * Both belong INSIDE the captured record channel, as sub-rows itemizing a total
 * the model already attributes. Adding them to the attributed sum would
 * double-count them.
 */

/** Not a real id — these terms have no game entity behind them. The renderer
 * takes their name from `label` and never looks an id up. */
const NO_ID = 0;

/** Cumulative cap-up per master level, from `skillboard_unlock.tbl`: index IS
 * the level, and the last entry is +100% at level 50. Sparse in the table (only
 * 11 levels grant anything) and already summed here. */
const MASTER_LEVEL_CAP = boardSources.masterLevelCap as number[];

/**
 * The cap a master level has accumulated, as an integer percent.
 *
 * `masterLevel` is level and master-break stars COMBINED (55 is level 50 plus
 * 5 stars) and the table stops at 50, so it is clamped: the stars grant no
 * further cap, and indexing past the last entry would read `undefined`.
 */
export const masterRankCapUp = (masterLevel: number): number =>
  MASTER_LEVEL_CAP[Math.min(Math.max(masterLevel, 0), MASTER_LEVEL_CAP.length - 1)] ?? 0;

export const accountFactors = (player: CapLoadout | undefined): CapFactor[] => {
  const masterLevel = player?.masterLevel ?? 0;

  return [
    {
      key: "account-master-rank",
      kind: "account",
      id: NO_ID,
      label: "ui.debug.cap-master-rank",
      level: masterLevel > 0 ? masterLevel : null,
      params: [],
      // An AI companion's record reads 0. Valuing that as +0% would claim they
      // have no rank bonus, which is a stronger statement than "this log
      // cannot say".
      evaluate: () =>
        masterLevel > 0 ? activeResult(masterRankCapUp(masterLevel)) : unknownResult(0, [], "value-unrecorded"),
    },
    {
      key: "account-mastery",
      kind: "account",
      id: NO_ID,
      label: "ui.debug.cap-mastery-collection",
      level: null,
      params: [],
      // The AP trees give an exact integer percent per node in the game's own
      // tables; what the log lacks is the set of nodes a player unlocked.
      evaluate: () => unknownResult(0, [], "value-unrecorded"),
    },
  ];
};
