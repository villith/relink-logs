import { summonBonusValue, toHashString } from "@/utils";

import type { CapClass, CapLoadout } from "../capSources";
import { overmasteryClass, summonBonusClass } from "./tables";
import { activeResult, notApplicableResult, unknownResult, type CapFactor, type CapFactorResult } from "./types";

/**
 * The two equipment families whose magnitudes the game has already worked out
 * for us: overmastery rolls, whose value is on the log, and summon equip
 * bonuses, whose per-level values ship with the app.
 *
 * Neither is conditional — a roll either raises this hit's class or it does
 * not — so both declare no params.
 */

const NO_PARAMS: readonly [] = [];

/** A factor that always returns the same already-decided result. */
const fixed = (base: Omit<CapFactor, "params" | "evaluate">, result: CapFactorResult): CapFactor => ({
  ...base,
  params: NO_PARAMS,
  evaluate: () => result,
});

/**
 * Every overmastery roll the player carries, matched against this hit's class.
 *
 * The magnitude is read off the log rather than a table because the game
 * already computed it per roll.
 */
export const overmasteryFactors = (player: CapLoadout | undefined, capClass: CapClass | null): CapFactor[] => {
  if (player === undefined || capClass === null) return [];

  return (player.overmasteryInfo?.overmasteries ?? []).map((entry, index): CapFactor => {
    // Indexed as well as hashed: a player can roll the same overmastery twice,
    // and two rows sharing a key would collide in the rendered list.
    const base = {
      key: `om-${index}-${toHashString(entry.id)}`,
      kind: "overmastery" as const,
      id: entry.id,
      label: null,
      level: null,
    };

    const rollClass = overmasteryClass[toHashString(entry.id)];
    if (rollClass === undefined) return fixed(base, notApplicableResult("not-a-cap-source"));
    if (rollClass !== capClass) return fixed(base, notApplicableResult("other-class"));
    // A roll whose value is zero carries only its level (a v2.0.2 town-loadout
    // recovery). Its real magnitude is unknown, so it is left unattributed
    // rather than counted as zero, which would claim it contributed nothing.
    if (entry.value === 0) return fixed(base, unknownResult(0, NO_PARAMS, "value-unrecorded"));
    return fixed(base, activeResult(entry.value));
  });
};

/** Every equipped summon's equip bonus, matched against this hit's class. */
export const summonFactors = (player: CapLoadout | undefined, capClass: CapClass | null): CapFactor[] => {
  if (player === undefined || capClass === null) return [];

  return (player.summons ?? []).map((summon, index): CapFactor => {
    const base = {
      key: `summon-${index}-${toHashString(summon.bonusId)}`,
      kind: "summon-bonus" as const,
      id: summon.bonusId,
      label: null,
      level: summon.bonusLevel,
    };

    const bonusClass = summonBonusClass[toHashString(summon.bonusId)];
    if (bonusClass === undefined) return fixed(base, notApplicableResult("not-a-cap-source"));
    if (bonusClass !== capClass) return fixed(base, notApplicableResult("other-class"));
    const value = summonBonusValue(summon.bonusId, summon.bonusLevel);
    if (value === null) return fixed(base, unknownResult(0, NO_PARAMS, "value-unrecorded"));
    return fixed(base, activeResult(value.amount));
  });
};
