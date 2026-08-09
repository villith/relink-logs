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

/** The plain DMG Cap trait. The one unconditional cap trait the game does NOT
 * fuse into the per-player record: the builder reads it through a second
 * lookup keyed by this very hash (`0xDC584F60`), so it attributes as its own
 * term. Confirmed 2026-08-09 by reconciling four players' oracle captures —
 * the multiplier content missing from the record equals this trait's table
 * value, and only this trait's. */
const DMG_CAP_TRAIT = 0xdc584f60;

const traits = capUpSources.traits as Record<string, number[][]>;
const conditionalTraits = capUpSources.conditionalTraits as Record<string, number[][]>;
const overmasteryClass = capUpSources.overmasteries as Record<string, CapClass>;
const summonBonusClass = capUpSources.summonBonuses as Record<string, CapClass>;

/** The per-class percentage a trait table holds at a combined level.
 *
 * Levels past the trait's top row are wasted, not extrapolated — the game
 * stops scaling at its last row, which is what the Builds tab flags. */
const traitRowValue = (table: Record<string, number[][]>, id: number, level: number, capClass: CapClass): number => {
  const levels = table[toHashString(id)];
  if (levels === undefined) return 0;
  const row = levels[Math.min(level, levels.length) - 1];
  return row === undefined ? 0 : row[SLOT[capClass]];
};

/** The plain DMG Cap trait's contribution, as the fraction the formula adds.
 *
 * Traits stack into ONE combined level across sigils, summon main traits,
 * wrightstone traits and weapon innates, and the value is looked up once at
 * that total — summing a per-sigil lookup instead multiplies the contribution
 * by the number of sigils carrying it. */
export const dmgCapTraitValue = (player: CapLoadout | undefined, capClass: CapClass | null): number => {
  if (player === undefined || capClass === null) return 0;
  const combined = computeCombinedTraits(player).find((trait) => trait.id === DMG_CAP_TRAIT);
  if (combined === undefined) return 0;
  return traitRowValue(traits, DMG_CAP_TRAIT, combined.level, capClass) / 100;
};

/** Every OTHER unconditional cap trait's contribution — the ones the game
 * fuses into the captured record, summed as one row. See [`DMG_CAP_TRAIT`]
 * for why that one is excluded here. */
const traitPercent = (player: CapLoadout, capClass: CapClass): number => {
  let total = 0;
  for (const trait of computeCombinedTraits(player)) {
    if (trait.id === DMG_CAP_TRAIT) continue;
    total += traitRowValue(traits, trait.id, trait.level, capClass);
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
 * The known components of the CAPTURED record channel, as fractions.
 *
 * These itemize what the game fused at load — other cap traits, overmastery
 * rolls, summon bonuses — so they render as sub-rows OF the captured number
 * and never add to the attributed total: the record already contains them.
 * Whatever share of the record they do not explain (skillboard nodes, the
 * master board) simply stays inside it, unnamed.
 */
export const deriveRecordComponents = (player: CapLoadout | undefined, capClass: CapClass | null): CapSource[] => {
  if (player === undefined || capClass === null) return [];
  return FAMILIES.map(({ key, labelKey, percent }) => ({
    key,
    labelKey,
    value: percent(player, capClass) / 100,
  })).filter((source) => source.value !== 0);
};

/**
 * The equipped CONDITIONAL cap traits, each at its maximum — HP/crit gates,
 * stacking buffs, timed procs. Rendered as their own rows and EXCLUDED from
 * the attributed total: their live value depends on runtime state the log
 * does not carry, and counting the maximum would shrink Unaccounted by a
 * number the formula did not necessarily use.
 */
export const deriveConditionalSources = (player: CapLoadout | undefined, capClass: CapClass | null): CapSource[] => {
  if (player === undefined || capClass === null) return [];
  const rows: CapSource[] = [];
  for (const trait of computeCombinedTraits(player)) {
    const value = traitRowValue(conditionalTraits, trait.id, trait.level, capClass) / 100;
    if (value !== 0) {
      rows.push({ key: `conditional-${toHashString(trait.id)}`, labelKey: "", traitId: trait.id, value });
    }
  }
  return rows;
};
