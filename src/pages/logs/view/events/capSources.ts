import capUpSources from "@/assets/cap-up-sources.json";
import type { PlayerData } from "@/types";
import { computeCombinedTraits, summonBonusValue, toHashString } from "@/utils";

import type { CapSource } from "./capBreakdown";

/** Which of the three per-class cap-ups a hit draws on. */
export type CapClass = "normal" | "skill" | "sba";

/** The stored loadout this reconstruction reads. Narrower than `PlayerData` on
 * purpose: the derivation cannot depend on anything it does not use. */
export type CapLoadout = Pick<PlayerData, "sigils" | "summons" | "weaponState" | "weaponInfo" | "overmasteryInfo">;

/** The attack class of a hit, from its `class_flags` (`instance+0xF0`).
 *
 * The order is the game builder's own: it tests `0x10000` first, but the
 * `0x40000` branch jumps past the skill assignment, so a hit carrying both is a
 * Skybound Art. `null` when the log predates the class capture — a guess there
 * would attribute sources the formula did not use. */
export const capClassOf = (classFlags: number | null): CapClass | null => {
  if (classFlags === null) return null;
  if (classFlags & 0x40000) return "sba";
  if (classFlags & 0x10000) return "skill";
  return "normal";
};

const SLOT: Record<CapClass, number> = { normal: 0, skill: 1, sba: 2 };

const traits = capUpSources.traits as Record<string, number[][]>;
const overmasteryClass = capUpSources.overmasteries as Record<string, CapClass>;
const summonBonusClass = capUpSources.summonBonuses as Record<string, CapClass>;

/** Every unconditional cap trait's contribution, as a percentage.
 *
 * Traits stack into ONE combined level across sigils, summon main traits,
 * wrightstone traits and weapon innates, and the value is looked up once at
 * that total — summing a per-sigil lookup instead multiplies the contribution
 * by the number of sigils carrying it. */
const traitPercent = (player: CapLoadout, capClass: CapClass): number => {
  let total = 0;
  for (const trait of computeCombinedTraits(player)) {
    const levels = traits[toHashString(trait.id)];
    if (levels === undefined) continue;
    // Levels past the trait's top row are wasted, not extrapolated — the game
    // stops scaling at its last row, which is what the Builds tab flags.
    const row = levels[Math.min(trait.level, levels.length) - 1];
    if (row !== undefined) total += row[SLOT[capClass]];
  }
  return total;
};

/** The overmastery rolls that raise THIS class's cap, summed.
 *
 * The magnitude is read off the log rather than a table because the game already
 * computed it per roll. A roll whose `value` is zero carries only its level (a
 * v2.0.2 town-loadout recovery) — its real magnitude is unknown, so it is left
 * unattributed rather than counted as zero, which would claim it contributed
 * nothing. */
const overmasteryPercent = (player: CapLoadout, capClass: CapClass): number =>
  (player.overmasteryInfo?.overmasteries ?? [])
    .filter((entry) => entry.value !== 0 && overmasteryClass[toHashString(entry.id)] === capClass)
    .reduce((sum, entry) => sum + entry.value, 0);

/** The equipped summons' cap-up equip bonuses for this class, summed. */
const summonPercent = (player: CapLoadout, capClass: CapClass): number => {
  let total = 0;
  for (const summon of player.summons ?? []) {
    if (summonBonusClass[toHashString(summon.bonusId)] !== capClass) continue;
    const value = summonBonusValue(summon.bonusId, summon.bonusLevel);
    if (value !== null) total += value.amount;
  }
  return total;
};

/** One row per source family, in a stable order, dropping the empty ones. */
const FAMILIES: { key: string; labelKey: string; percent: (p: CapLoadout, c: CapClass) => number }[] = [
  { key: "trait", labelKey: "ui.logs.cap-source-trait", percent: traitPercent },
  { key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", percent: overmasteryPercent },
  { key: "summon", labelKey: "ui.logs.cap-source-summon", percent: summonPercent },
];

/**
 * The cap-up this player's stored loadout accounts for, as fractions the
 * formula adds (0.5 renders as +50%).
 *
 * This is an INDEPENDENT reconstruction, not a decomposition: the game fuses
 * every source into one number per class before the hook sees it, so whatever
 * this misses shows up in the card's Unaccounted row rather than being hidden.
 * Sources deliberately absent, because their magnitude is not a function of the
 * loadout alone: the four conditional cap traits (Cobalt and Ecru scale with
 * live crit rate and max HP; Cardinal and Sage are stacking buffs), skillboard
 * nodes, and the master trait rank.
 */
export const deriveCapSources = (player: CapLoadout | undefined, capClass: CapClass | null): CapSource[] => {
  if (player === undefined || capClass === null) return [];
  return FAMILIES.map(({ key, labelKey, percent }) => ({
    key,
    labelKey,
    value: percent(player, capClass) / 100,
  })).filter((source) => source.value !== 0);
};
