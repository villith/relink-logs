import type { PlayerData } from "@/types";
import { computeCombinedTraits, isEmptyId, toHashString } from "@/utils";

import type { CapSource } from "./capBreakdown";
import { overmasteryFactors, summonFactors } from "./capFactors/equipment";
import { SLOT, conditionalTraitTable, traitRow, traitRowValue, traitTable } from "./capFactors/tables";
import { DMG_CAP_TRAIT } from "./capFactors/traits";
import type { CapFactor, CapFactorReason } from "./capFactors/types";

/** Which of the three per-class cap-ups a hit draws on. */
export type CapClass = "normal" | "skill" | "sba";

/** The stored loadout this reconstruction reads. Narrower than `PlayerData` on
 * purpose: the derivation cannot depend on anything it does not use.
 *
 * The master-board half is optional rather than required, because older logs
 * genuinely lack it — and because every fixture that predates the board
 * itemization stays valid, so a test asserting trait behaviour does not have to
 * pretend to own a skillboard. */
export type CapLoadout = Pick<PlayerData, "sigils" | "summons" | "weaponState" | "weaponInfo" | "overmasteryInfo"> &
  Partial<
    Pick<
      PlayerData,
      "skillboard" | "characterType" | "masterLevel" | "limitBonusCapNormal" | "limitBonusCapSkill" | "limitBonusCapSba"
    >
  >;

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

/** Why a considered contributor added nothing to THIS hit's cap.
 *
 * A rejected source has to stay visible and say why: in a breakdown, a source
 * that was weighed and dismissed is indistinguishable from one the model never
 * knew about unless it names its own reason. */
export type CapExclusion =
  /** No row in any cap table — an ATK or HP trait, a non-cap overmastery roll. */
  | "not-a-cap-source"
  /** A conditional cap trait; itemized by `deriveConditionalSources` instead. */
  | "conditional"
  /** The plain DMG Cap trait, which is its own term outside the record. */
  | "dmg-cap-trait"
  /** A cap source, but one that raises a different attack class. */
  | "other-class"
  /** In the table, but its row is all zeroes at the level reached. */
  | "zero-at-level"
  /** A magnitude the log never captured (a v2.0.2 town-loadout recovery). */
  | "value-unrecorded";

/** One contributor the cap model considered, whether or not it gave anything.
 *
 * `percent` is in the tables' own units (30 means +30%), which is what keeps
 * these summable back into the family totals with bit-identical arithmetic. */
export type CapContribution = {
  key: string;
  /** Trait id, overmastery id or summon bonus id — what to translate for a name. */
  id: number;
  /** Combined trait level or summon bonus level; `null` for an overmastery roll,
   * whose magnitude comes off the log rather than a table. */
  level: number | null;
  /** The three-class table row this was read from, when it has one. Carried even
   * for a rejected source: `[0, 30, 0]` is what says WHICH class it raises. */
  row: number[] | null;
  percent: number;
  /** `null` when it contributed. */
  excluded: CapExclusion | null;
};

const sumPercents = (rows: CapContribution[]): number => rows.reduce((total, row) => total + row.percent, 0);

/**
 * Every combined trait the player carries, each with the row it was looked up
 * in and what it contributed to this hit's class.
 *
 * One entry per trait, never filtered — the family totals below are sums over
 * this list, so what the tooltip shows as one number is exactly what the debug
 * panel itemizes.
 */
export const enumerateTraits = (player: CapLoadout | undefined, capClass: CapClass | null): CapContribution[] => {
  if (player === undefined || capClass === null) return [];
  return computeCombinedTraits(player).map((trait): CapContribution => {
    const base = { key: `trait-${toHashString(trait.id)}`, id: trait.id, level: trait.level, percent: 0 };
    // Checked before the unconditional table: this one trait reaches the
    // formula through its own second lookup, so counting it here would
    // double-attribute it against the record that does not contain it.
    if (trait.id === DMG_CAP_TRAIT) {
      return { ...base, row: traitRow(traitTable, trait.id, trait.level), excluded: "dmg-cap-trait" };
    }
    const conditional = traitRow(conditionalTraitTable, trait.id, trait.level);
    if (conditional !== null) return { ...base, row: conditional, excluded: "conditional" };

    const row = traitRow(traitTable, trait.id, trait.level);
    if (row === null) return { ...base, row: null, excluded: "not-a-cap-source" };
    const percent = row[SLOT[capClass]];
    if (percent !== 0) return { ...base, row, percent, excluded: null };
    // A zero can mean two different things, and the reader needs to know which:
    // a cap trait for another class, or one that has not scaled in yet.
    return { ...base, row, excluded: row.some((value) => value !== 0) ? "other-class" : "zero-at-level" };
  });
};

/** The reasons the two equipment families can give, in `CapExclusion`'s
 * vocabulary. The factor model's other reasons belong to traits and board
 * nodes, which do not reach this adapter. */
const EQUIPMENT_EXCLUSION: Partial<Record<CapFactorReason, CapExclusion>> = {
  "not-a-cap-source": "not-a-cap-source",
  "other-class": "other-class",
  "value-unrecorded": "value-unrecorded",
};

/** A factor restated as a contribution.
 *
 * Neither equipment family is conditional, so evaluating against an empty
 * conditions bag is the whole of what they can say. The class-matching rules
 * themselves live once, in `capFactors/equipment`, because two copies of them
 * drift the moment a new exclusion case appears. */
const contributionOf = (factor: CapFactor): CapContribution => {
  const result = factor.evaluate({});
  return {
    key: factor.key,
    id: factor.id,
    level: factor.level,
    row: null,
    percent: result.percent,
    excluded:
      result.state === "active" ? null : EQUIPMENT_EXCLUSION[result.reason ?? "not-a-cap-source"] ?? "not-a-cap-source",
  };
};

/** Every overmastery roll the player carries, matched against this hit's class. */
export const enumerateOvermasteries = (player: CapLoadout | undefined, capClass: CapClass | null): CapContribution[] =>
  overmasteryFactors(player, capClass).map(contributionOf);

/** Every equipped summon's equip bonus, matched against this hit's class. */
export const enumerateSummons = (player: CapLoadout | undefined, capClass: CapClass | null): CapContribution[] =>
  summonFactors(player, capClass).map(contributionOf);

/** Sigil Booster, the terminus-weapon innate that raises every equipped
 * sigil's trait levels by its own level. The base skill id and the
 * upgrade-resolved variant the hook captures live are both listed — a live
 * innate block carries the variant. */
const SIGIL_BOOSTER_TRAITS = [0x57e8a93f, 0x57e92e3f];

const sigilBoosterLevel = (player: CapLoadout): number =>
  (player.weaponState?.innateTraits ?? []).reduce(
    (total, trait) => total + (SIGIL_BOOSTER_TRAITS.includes(trait.id) ? trait.level : 0),
    0
  );

/** How many equipped sigil trait slots carry the trait — the multiplier on the
 * booster, which raises each SLOT by its level, not the combined total once. */
const sigilInstanceCount = (player: CapLoadout, traitId: number): number => {
  let count = 0;
  for (const sigil of player.sigils ?? []) {
    if (isEmptyId(sigil.sigilId)) continue;
    if (sigil.firstTraitId === traitId && sigil.firstTraitLevel > 0) count += 1;
    if (sigil.secondTraitId === traitId && sigil.secondTraitLevel > 0) count += 1;
  }
  return count;
};

/** The plain DMG Cap trait's contribution, as the fraction the formula adds.
 *
 * Traits stack into ONE combined level across sigils, summon main traits,
 * wrightstone traits and weapon innates, and the value is looked up once at
 * that total — summing a per-sigil lookup instead multiplies the contribution
 * by the number of sigils carrying it. Sigil Booster raises each sigil-sourced
 * level before the combine: log 2573's oracle reconciliation had every local
 * player's cap exactly one +3-level row (3 sigils x booster 1) above the raw
 * combined level, on every hit, in every class. */
export const dmgCapTraitValue = (player: CapLoadout | undefined, capClass: CapClass | null): number => {
  if (player === undefined || capClass === null) return 0;
  const combined = computeCombinedTraits(player).find((trait) => trait.id === DMG_CAP_TRAIT);
  if (combined === undefined) return 0;
  const level = combined.level + sigilBoosterLevel(player) * sigilInstanceCount(player, DMG_CAP_TRAIT);
  return traitRowValue(traitTable, DMG_CAP_TRAIT, level, capClass) / 100;
};

/** Every OTHER unconditional cap trait's contribution — the ones the game
 * fuses into the captured record, summed as one row. See [`DMG_CAP_TRAIT`]
 * for why that one is excluded here.
 *
 * These three are sums over the enumerations above rather than separate walks:
 * the tooltip's one number and the debug panel's line items then cannot
 * disagree, because they are the same arithmetic. */
const traitPercent = (player: CapLoadout, capClass: CapClass): number => sumPercents(enumerateTraits(player, capClass));

/** The overmastery rolls that raise THIS class's cap, summed.
 *
 * The magnitude is read off the log rather than a table because the game already
 * computed it per roll. A roll whose `value` is zero carries only its level (a
 * v2.0.2 town-loadout recovery) — its real magnitude is unknown, so it is left
 * unattributed rather than counted as zero, which would claim it contributed
 * nothing. */
const overmasteryPercent = (player: CapLoadout, capClass: CapClass): number =>
  sumPercents(enumerateOvermasteries(player, capClass));

/** The equipped summons' cap-up equip bonuses for this class, summed. */
const summonPercent = (player: CapLoadout, capClass: CapClass): number =>
  sumPercents(enumerateSummons(player, capClass));

/**
 * The captured Mastery (AP-tree) total for the hit's class, in table units, or
 * `null` when this log never carried one.
 *
 * Read from the game's own resolved limit-bonus store — every cap-typed entry
 * in it is an `ap_tree_*` bonus (verified against the tables 2026-08-10), so
 * it is the fused character-plus-weapon-trees answer, not another derivation.
 * A component of the captured record like the families above: it itemizes that
 * total and is never added to it.
 */
export const limitBonusCapOf = (player: CapLoadout | undefined, capClass: CapClass | null): number | null => {
  if (player === undefined || capClass === null) return null;
  const value =
    capClass === "normal"
      ? player.limitBonusCapNormal
      : capClass === "skill"
        ? player.limitBonusCapSkill
        : player.limitBonusCapSba;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** One row per source family, in a stable order, dropping the empty ones. */
const FAMILIES: { key: string; labelKey: string; percent: (p: CapLoadout, c: CapClass) => number }[] = [
  { key: "trait", labelKey: "ui.logs.cap-source-trait", percent: traitPercent },
  { key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", percent: overmasteryPercent },
  { key: "summon", labelKey: "ui.logs.cap-source-summon", percent: summonPercent },
  { key: "mastery", labelKey: "ui.logs.cap-source-mastery", percent: (p, c) => limitBonusCapOf(p, c) ?? 0 },
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
    const value = traitRowValue(conditionalTraitTable, trait.id, trait.level, capClass) / 100;
    if (value !== 0) {
      rows.push({ key: `conditional-${toHashString(trait.id)}`, labelKey: "", traitId: trait.id, value });
    }
  }
  return rows;
};
