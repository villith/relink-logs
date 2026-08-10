import apTreeSources from "@/assets/ap-tree-cap-sources.json";
import boardSources from "@/assets/skillboard-cap-sources.json";
import { toHashString } from "@/utils";

import { limitBonusCapOf, type CapClass, type CapLoadout } from "../capSources";
import { activeResult, unknownResult, type CapFactor } from "./types";

/**
 * The account-wide cap-up terms — the ones that come from progression rather
 * than from anything equipped.
 *
 * The master trait RANK bonus is derived here. The AP trees (the game's Mastery
 * screens) are valued exactly in the game's tables but their input — which tree
 * nodes a player unlocked — is not on the log, so they stay named and
 * unresolved. What they CAN say is what a completed set is worth, which is the
 * `potential` these rows carry: a ceiling on the term, not a claim about this
 * player.
 *
 * All of these belong INSIDE the captured record channel, as sub-rows itemizing
 * a total the model already attributes. Adding them to the attributed sum would
 * double-count them — which is also why an unresolved potential here is safe:
 * `evaluateCapFactors` never adds a potential to `attributed`.
 */

/** Not a real id — these terms have no game entity behind them. The renderer
 * takes their name from `label` and never looks an id up. */
const NO_ID = 0;

/** Cumulative cap-up per master level, from `skillboard_unlock.tbl`: index IS
 * the level, and the last entry is +100% at level 50. Sparse in the table (only
 * 11 levels grant anything) and already summed here. */
const MASTER_LEVEL_CAP = boardSources.masterLevelCap as number[];

/** Per owner, what a fully completed set of trees grants, by cap class. Built by
 * `gen-ap-tree-cap-sources.mjs` out of `ap_tree_*` → `limit_bonus` →
 * `limit_bonus_param`. Characters own the Offense/Defense trees; weapons own the
 * weapon and rebuild trees, so the two are keyed separately — summing them into
 * one number would price every weapon a character owns at once. */
type CapPotential = Partial<Record<CapClass | "all", number>>;
const CHARACTER_POTENTIAL = apTreeSources.characterPotential as Record<string, CapPotential>;
const WEAPON_POTENTIAL = apTreeSources.weaponPotential as Record<string, CapPotential>;

/**
 * The cap a completed tree set would grant a hit of this class.
 *
 * `all` is added on top of the class's own total because a node typed 106 raises
 * every class. No AP-tree node is typed 106 on v2.0.4 — every one is skill or
 * Skybound Art — but reading the class out rather than assuming it keeps a game
 * update from silently dropping a term.
 */
const potentialFor = (potential: CapPotential | undefined, capClass: CapClass | null): number => {
  if (potential === undefined || capClass === null) return 0;
  return (potential[capClass] ?? 0) + (potential.all ?? 0);
};

/**
 * The cap a master level has accumulated, as an integer percent.
 *
 * `masterLevel` is level and master-break stars COMBINED (55 is level 50 plus
 * 5 stars) and the table stops at 50, so it is clamped: the stars grant no
 * further cap, and indexing past the last entry would read `undefined`.
 */
export const masterRankCapUp = (masterLevel: number): number =>
  MASTER_LEVEL_CAP[Math.min(Math.max(masterLevel, 0), MASTER_LEVEL_CAP.length - 1)] ?? 0;

export const accountFactors = (player: CapLoadout | undefined, capClass: CapClass | null): CapFactor[] => {
  const masterLevel = player?.masterLevel ?? 0;
  const character = typeof player?.characterType === "string" ? player.characterType.toLowerCase() : null;
  const weaponId = player?.weaponInfo?.weaponId;
  const masteryTotal = limitBonusCapOf(player, capClass);

  const masterRank: CapFactor = {
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
  };

  // The captured total answers what the two potential rows ask, so it REPLACES
  // them: keeping them alongside would report an open question that is closed.
  // (The master rank bonus is not in the store — it stays its own row.)
  if (masteryTotal !== null) {
    return [
      masterRank,
      {
        key: "account-mastery-total",
        kind: "account",
        id: NO_ID,
        label: "ui.debug.cap-mastery-total",
        level: null,
        params: [],
        evaluate: () => activeResult(masteryTotal),
      },
    ];
  }

  return [
    masterRank,
    {
      key: "account-mastery",
      kind: "account",
      id: NO_ID,
      label: "ui.debug.cap-mastery-collection",
      level: null,
      params: [],
      evaluate: () =>
        unknownResult(
          potentialFor(character === null ? undefined : CHARACTER_POTENTIAL[character], capClass),
          [],
          "unlocks-unrecorded"
        ),
    },
    {
      // The weapon's own two trees are a different owner, not more of the same:
      // they follow the EQUIPPED weapon, so they change when the weapon does.
      key: "account-weapon-trees",
      kind: "account",
      id: NO_ID,
      label: "ui.debug.cap-weapon-trees",
      level: null,
      params: [],
      evaluate: () =>
        unknownResult(
          potentialFor(weaponId === undefined ? undefined : WEAPON_POTENTIAL[toHashString(weaponId)], capClass),
          [],
          "unlocks-unrecorded"
        ),
    },
  ];
};
