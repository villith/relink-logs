import { open } from "@tauri-apps/api/shell";
import html2canvas from "html2canvas";
import * as jsurl from "jsurl";
import toast from "react-hot-toast";
import {
  CharacterType,
  ComputedPlayerState,
  EncounterState,
  EnemyState,
  EnemyType,
  MeterColumns,
  PlayerData,
  PlayerState,
  Sigil,
  SkillState,
  SkillTargetState,
  SortDirection,
  SortType,
} from "./types";

import checklistDefault from "@/assets/checklist-default.json";
import sigilTraitCategories from "@/assets/sigil-trait-categories.json";
import skillboardLayout from "@/assets/skillboard-layout.json";
import summonBonusValues from "@/assets/summon-bonus-values.json";
import traitMaxLevels from "@/assets/trait-max-levels.json";
import weaponTraitsData from "@/assets/weapon-traits.json";
import weaponTranscendenceData from "@/assets/weapon-transcendence.json";
import i18next, { t } from "i18next";
import { useEffect, useRef, type CSSProperties } from "react";

import { abilitySourceKeys, stripTierSuffix, summonClassSource } from "./skillNameSources";

export const EMPTY_ID = 2289754288;

export const formatInPartyOrder = (party: Record<string, PlayerState>): ComputedPlayerState[] => {
  const players = Object.keys(party).map((key) => {
    return party[key];
  });

  players.sort((a, b) => a.index - b.index);

  return players.map((player, i) => ({
    partyIndex: i,
    percentage: 0,
    ...player,
  }));
};

/** The target whose HP bar the meter should show: the largest HP pool still
 * standing (bosses dwarf adds/parts), or null when no target reported HP.
 *
 * Killed targets stay in the map for the rest of the encounter, so preferring
 * the living ones is what moves the readout on to the next enemy instead of
 * pinning it at 0% behind a corpse. Once everything we've hit is dead we fall
 * back to the largest pool, leaving the finished boss on screen at 0%. */
export const getBossHpTarget = (targets: Record<number, EnemyState>): EnemyState | null => {
  let boss: EnemyState | null = null;
  let living: EnemyState | null = null;

  for (const target of Object.values(targets)) {
    // `null`, not just `undefined`: these mirror Rust `Option<u64>` fields with no
    // `skip_serializing_if`, so an absent pool arrives as JSON `null`. Testing only
    // for `undefined` let those rows through and rendered `HP NaN% (0 / 0)`.
    const { currentHp, maxHp } = target;
    if (currentHp == null || maxHp == null) continue;
    if (boss === null || maxHp > boss.maxHp!) boss = target;
    if (currentHp > 0 && (living === null || maxHp > living.maxHp!)) living = target;
  }

  return living ?? boss;
};

export const isSupplementaryAction = (actionType: SkillState["actionType"]): boolean =>
  typeof actionType === "object" && Object.hasOwn(actionType, "SupplementaryDamage");

/**
 * Only Normal skill hits can trigger supplementary damage — Link Attacks, Skybound
 * Arts and damage-over-time cannot. (Groups are frontend merges of Normal skills.)
 */
export const isSupEligibleAction = (actionType: SkillState["actionType"]): boolean =>
  typeof actionType === "object" && (Object.hasOwn(actionType, "Normal") || Object.hasOwn(actionType, "Group"));

export type SupPercentages = {
  /** Supp damage relative to supp-eligible (Normal skill) damage — the proc-quality
   * number. Each source procs at +20% of the trigger hit, so with all three equipped
   * and a 100% proc rate this tops out at +60%. */
  eligible: number;
  /** Supp damage as a share of the player's total damage, ineligible sources
   * (Link Attack, SBA, DoT) included. */
  overall: number;
};

/**
 * Extra damage from supplementary-type procs (sigil, Berserker/Spartan echo).
 */
export const computeSupPercentage = (player: PlayerState): SupPercentages => {
  let suppDamage = 0;
  let eligibleDamage = 0;
  for (const skill of player.skillBreakdown) {
    if (isSupplementaryAction(skill.actionType)) {
      suppDamage += skill.totalDamage;
    } else if (isSupEligibleAction(skill.actionType)) {
      eligibleDamage += skill.totalDamage;
    }
  }

  return {
    eligible: eligibleDamage > 0 ? (suppDamage / eligibleDamage) * 100 : 0,
    overall: player.totalDamage > 0 ? (suppDamage / player.totalDamage) * 100 : 0,
  };
};

/**
 * A bonus magnitude in one of the three units the Builds tab shows: a flat
 * stat amount, a percentage, or (when the real magnitude is unknown, e.g.
 * v2.0.2-recovered overmasteries) a bare level.
 */
export type BonusAmount = { kind: "flat" | "percent" | "level"; amount: number };

/**
 * Raw display value for a summon equip bonus — the real magnitude from the
 * game's summon_base_param table (see scripts/gen-summon-bonus-values.py).
 * Null when the bonus id or level isn't in the extracted table.
 */
export const summonBonusValue = (bonusId: number, bonusLevel: number): BonusAmount | null => {
  const entry = (summonBonusValues as Record<string, { values: number[]; percent: boolean }>)[toHashString(bonusId)];
  const value = entry?.values[bonusLevel];
  if (value === undefined) return null;
  return { kind: entry.percent ? "percent" : "flat", amount: value };
};

/** summonBonusValue, display-formatted: "+1800" or "+20%". */
export const formatSummonBonusValue = (bonusId: number, bonusLevel: number): string | null => {
  const value = summonBonusValue(bonusId, bonusLevel);
  return value === null ? null : `+${value.amount}${value.kind === "percent" ? "%" : ""}`;
};

/** A bonus magnitude in the game's own notation: "+1800", "+20%", "(Lvl. 3)". */
export const formatBonusAmount = (value: BonusAmount): string =>
  value.kind === "level"
    ? `(Lvl. ${value.amount})`
    : `+${Number(value.amount.toFixed(2))}${value.kind === "percent" ? "%" : ""}`;

/** One contribution to a combined bonus line: an overmastery roll or a summon's equip bonus. */
export type BonusSource = {
  kind: "overmastery" | "summon";
  /** Overmastery id / summon id — what to translate for the tooltip. */
  sourceId: number;
  value: BonusAmount;
};

export type CombinedBonus = {
  /** The translated effect name — the grouping key ("do the same thing"). */
  name: string;
  sources: BonusSource[];
  /** Per-unit sums over the sources, in flat / percent / level order; zero units dropped. */
  totals: BonusAmount[];
};

/**
 * One representative overmastery id per distinct effect — the game's 258
 * overmastery ids are magnitude tiers of just these 11 effects (summon equip
 * bonuses share the same effects). Translate these for the canonical
 * every-effect display list, in this order.
 */
export const OVERMASTERY_EFFECT_IDS = [
  0x06595c52, // Normal Attack Damage Cap Up
  0x0b0e4311, // Skill Damage Cap Up
  0x047b7a70, // Skybound Art Damage Cap Up
  0x0b134a7f, // Attack Power Up
  0x1296ed4a, // Critical Hit Rate Up
  0x2676f9d2, // Stun Power Up
  0x032a5217, // Health Up
  0x0d6b32a3, // Skill Damage Up
  0x020d2c07, // Skybound Art Damage Up
  0x2989cae9, // Chain Burst Damage Up
  0x43d71e8f, // Healing Cap Up
];

/**
 * The effect kind of a predicted overmastery — limit_bonus_param's
 * `DisplayNumberMultiplier` column, which despite the name is a format id:
 * 0 = ATK, 1 = HP, 2 = Critical Hit Rate, 3 = Stun Power. 100+ are the
 * damage-type specials (Skill/SBA/Chain Burst DMG Up, the cap ups, Healing
 * Cap Up), all percentages.
 */
const OVERMASTERY_KIND_ATTACK = 0;
const OVERMASTERY_KIND_HEALTH = 1;
const OVERMASTERY_KIND_STUN_POWER = 3;

/**
 * Stun Power Up is the one effect the game stores at a tenth of the number it
 * displays: the kind-3 ladder is [0.1, 0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.6, 2]
 * and its Lv7 row (raw 1.0) reads "Stun Power Up +10" in game. It is a flat
 * amount, not a percentage. summon_base_param carries the same x10 for the
 * same effect in its `ValueDisplayMultiplier` column, which
 * gen-summon-bonus-values.py already bakes into summon-bonus-values.json — so
 * scaling here is what puts overmastery and summon Stun Power Up on one scale
 * before a Builds-tab line sums them.
 */
const STUN_POWER_DISPLAY_MULTIPLIER = 10;

/** Every Stun Power Up id — the 19 magnitude tiers of that one effect. */
const STUN_POWER_OVERMASTERY_IDS = new Set([
  0x2676f9d2, 0x2c1c933d, 0x3356dd03, 0x36f068fd, 0x3dae6494, 0x455d6a1c, 0x59fbb7d8, 0x6837e60c, 0x6cb38ef3,
  0x7b05e679, 0x7b498c32, 0x9bf7878a, 0xa3545ca1, 0xa85495ba, 0xa901e065, 0xc11fdfbd, 0xd5169339, 0xd63dd12b,
  0xf5c314a0,
]);

/**
 * Overmastery ids whose value is a flat stat amount — every Attack Power Up,
 * Health Up and Stun Power Up tier. All other ids display as percentages.
 */
const OVERMASTERY_FLAT_VALUE_IDS = new Set([
  0x032a5217,
  0x0781c7a2,
  0x0b134a7f,
  0x0cf5d0f3,
  0x0db88f30,
  0x0f25b474,
  0x0febc993,
  0x11023c6f,
  0x124db819,
  0x1268b903,
  0x13c9452a,
  0x155c25c3,
  0x1cc2f730,
  0x1e2b3db5,
  0x24499a25,
  0x254a08d4,
  0x2d6c03eb,
  0x2ea457f3,
  0x303becc0,
  0x3526fecb,
  0x38f656e7,
  0x394083bd,
  0x3ac53494,
  0x3ca4c8d5,
  0x3d6600d9,
  0x403be586,
  0x409df671,
  0x427b5e26,
  0x437c055d,
  0x44f04a7a,
  0x49089d4f,
  0x4ab91ea7,
  0x4c0cbd32,
  0x4ce64874,
  0x4e2513df,
  0x52a207b5,
  0x5382923d,
  0x53d358e0,
  0x5767dd9f,
  0x57bbc478,
  0x59dce1e8,
  0x5a51f0cb,
  0x5a57dc07,
  0x60835d4f,
  0x60926b53,
  0x61d4efa0,
  0x6564c02b,
  0x66092bc7,
  0x67bde89b,
  0x6e4f2f5e,
  0x6fb47781,
  0x7125942e,
  0x7cbbb4e0,
  0x7ccf98c5,
  0x7e870ebe,
  0x807e9e58,
  0x829b8b5c,
  0x834892b4,
  0x85f0f318,
  0x871d12cc,
  0x874353d7,
  0x8af65803,
  0x8e66b68c,
  0x8fe7fb0a,
  0x911d4f18,
  0x91265f66,
  0x93572974,
  0x937efb96,
  0x95567556,
  0x9a0988df,
  0x9a29aa64,
  0x9b6f164c,
  0x9bfd4548,
  0x9c6375cf,
  0xa1dc63b3,
  0xa257dac1,
  0xa2bcf523,
  0xa3460028,
  0xa85b4af5,
  0xaac23948,
  0xab56bde3,
  0xaccbece1,
  0xaf0d8b97,
  0xb83aa115,
  0xbbe7992a,
  0xbd488071,
  0xbe8c17d4,
  0xbf44c20b,
  0xc1360291,
  0xc265b03b,
  0xc2d708c1,
  0xc4925bd7,
  0xc52d2245,
  0xc5d68c62,
  0xc6bdc7a6,
  0xcb43ff8e,
  0xcb63be55,
  0xcb6bb434,
  0xccef4492,
  0xcd5d6315,
  0xcf24e1a2,
  0xcf6b267a,
  0xd4b918ea,
  0xd51958d1,
  0xda546dfe,
  0xdcbd8423,
  0xddc29837,
  0xde6a367a,
  0xdf2cab83,
  0xdf2eef09,
  0xdfb00115,
  0xe056ba80,
  0xe7710898,
  0xea5eaafc,
  0xea99fa76,
  0xee6100ca,
  0xeefb4ade,
  0xf004e9f2,
  0xf203bb15,
  0xf2111b99,
  0xf5514f81,
  0xf80e3310,
  0xfa230938,
  0xfa9bcf64,
  0xfb276afd,
  0xfe71865d,
  ...STUN_POWER_OVERMASTERY_IDS,
]);

/** Raw stored value -> the magnitude the game shows for a Stun Power Up. */
const stunPowerAmount = (value: number): BonusAmount => ({
  kind: "flat",
  amount: Math.round(value * STUN_POWER_DISPLAY_MULTIPLIER * 100) / 100,
});

/**
 * Display magnitude of a predicted overmastery, from its effect kind — what
 * the Overmastery Predictor shows against a rolled effect.
 */
export const overmasteryAmountFromKind = (kind: number, value: number): BonusAmount =>
  kind === OVERMASTERY_KIND_STUN_POWER
    ? stunPowerAmount(value)
    : {
        kind: kind === OVERMASTERY_KIND_ATTACK || kind === OVERMASTERY_KIND_HEALTH ? "flat" : "percent",
        amount: value,
      };

/**
 * Display magnitude of an overmastery read off a player's record, from its id
 * — the Builds tab's path, where the kind isn't carried alongside the value.
 */
export const overmasteryAmountFromId = (id: number, value: number): BonusAmount =>
  STUN_POWER_OVERMASTERY_IDS.has(id)
    ? stunPowerAmount(value)
    : { kind: OVERMASTERY_FLAT_VALUE_IDS.has(id) ? "flat" : "percent", amount: value };

/**
 * Expands combined bonuses to the full canonical effect list: every name in
 * `allNames` gets a row (an empty group when the player has none — render it
 * grayed out), and combined groups the list doesn't know are appended rather
 * than dropped.
 */
export const fillBonusGroups = (combined: CombinedBonus[], allNames: string[]): CombinedBonus[] => {
  const byName = new Map(combined.map((bonus) => [bonus.name, bonus]));
  return [
    ...allNames.map((name) => byName.get(name) ?? { name, sources: [], totals: [] }),
    ...combined.filter((bonus) => !allNames.includes(bonus.name)),
  ];
};

/**
 * Merges same-effect bonuses (same translated name — one effect spans many
 * ids across overmasteries and summon bonuses) into one line each, keeping
 * first-seen order and the per-source breakdown for the tooltip.
 */
export const groupBonuses = (entries: { name: string; source: BonusSource }[]): CombinedBonus[] => {
  const groups = new Map<string, BonusSource[]>();
  for (const entry of entries) {
    let sources = groups.get(entry.name);
    if (!sources) groups.set(entry.name, (sources = []));
    sources.push(entry.source);
  }
  return [...groups.entries()].map(([name, sources]) => ({
    name,
    sources,
    totals: (["flat", "percent", "level"] as const)
      .map((kind) => ({
        kind,
        amount: sources.reduce((acc, source) => acc + (source.value.kind === kind ? source.value.amount : 0), 0),
      }))
      .filter((total) => total.amount !== 0),
  }));
};

export type CombinedTrait = { id: number; level: number };

/**
 * Per-trait level totals across the wrightstone (weapon-state traits, or the
 * legacy weaponInfo trait slots), summon main traits, sigil traits, and the
 * weapon's innate skills (weapon-state only — the legacy weaponInfo shape has
 * no innate data). Sorted by total level descending, then id.
 */
type TraitSourcesInput = Pick<PlayerData, "sigils" | "summons" | "weaponState" | "weaponInfo">;

/** The wrightstone's trait pairs: weapon-state ones, or the legacy weaponInfo slots. */
const wrightstoneTraitPairs = (player: TraitSourcesInput): { id: number; level: number }[] =>
  player.weaponState
    ? player.weaponState.wrightstoneTraits
    : player.weaponInfo
      ? [
          { id: player.weaponInfo.trait1Id, level: player.weaponInfo.trait1Level },
          { id: player.weaponInfo.trait2Id, level: player.weaponInfo.trait2Level },
          { id: player.weaponInfo.trait3Id, level: player.weaponInfo.trait3Level },
        ]
      : [];

export const computeCombinedTraits = (player: TraitSourcesInput): CombinedTrait[] => {
  const totals = new Map<number, number>();
  const add = (id: number, level: number) => {
    if (!id || id === EMPTY_ID || level <= 0) return;
    totals.set(id, (totals.get(id) ?? 0) + level);
  };

  for (const sigil of player.sigils ?? []) {
    if (sigil.sigilId === EMPTY_ID) continue;
    add(sigil.firstTraitId, sigil.firstTraitLevel);
    add(sigil.secondTraitId, sigil.secondTraitLevel);
  }
  for (const summon of player.summons ?? []) {
    add(summon.mainTraitId, summon.mainTraitLevel);
  }
  for (const trait of wrightstoneTraitPairs(player)) {
    add(trait.id, trait.level);
  }
  for (const trait of player.weaponState?.innateTraits ?? []) {
    add(trait.id, trait.level);
  }

  return [...totals.entries()].map(([id, level]) => ({ id, level })).sort((a, b) => b.level - a.level || a.id - b.id);
};

export type TraitSource = {
  kind: "sigil" | "summon" | "wrightstone" | "weapon";
  /** Sigil id / summon id / wrightstone item id / weapon id — what to translate for display. */
  sourceId: number;
  level: number;
};

/**
 * Every equipment piece contributing to any of `traitIds` (a checklist id
 * group), with the level it contributes — the per-source breakdown behind
 * a combined-trait total.
 */
export const collectTraitSources = (player: TraitSourcesInput, traitIds: number[]): TraitSource[] => {
  const matches = (id: number, level: number) => id !== EMPTY_ID && level > 0 && traitIds.includes(id);
  const sources: TraitSource[] = [];

  for (const sigil of player.sigils ?? []) {
    if (sigil.sigilId === EMPTY_ID) continue;
    if (matches(sigil.firstTraitId, sigil.firstTraitLevel)) {
      sources.push({ kind: "sigil", sourceId: sigil.sigilId, level: sigil.firstTraitLevel });
    }
    if (matches(sigil.secondTraitId, sigil.secondTraitLevel)) {
      sources.push({ kind: "sigil", sourceId: sigil.sigilId, level: sigil.secondTraitLevel });
    }
  }
  for (const summon of player.summons ?? []) {
    if (matches(summon.mainTraitId, summon.mainTraitLevel)) {
      sources.push({ kind: "summon", sourceId: summon.summonId, level: summon.mainTraitLevel });
    }
  }
  const wrightstoneId = player.weaponState?.wrightstoneId ?? player.weaponInfo?.wrightstoneId ?? 0;
  for (const trait of wrightstoneTraitPairs(player)) {
    if (matches(trait.id, trait.level)) {
      sources.push({ kind: "wrightstone", sourceId: wrightstoneId, level: trait.level });
    }
  }
  for (const trait of player.weaponState?.innateTraits ?? []) {
    if (matches(trait.id, trait.level)) {
      sources.push({ kind: "weapon", sourceId: player.weaponState!.weaponId, level: trait.level });
    }
  }

  return sources;
};

export type SkillboardTierKey = 1 | 2 | 3 | "ex";

/**
 * The character's real master-trait board: node ids (EffectUiId, what the hook
 * emits) per tier, from the game's skillboard_layout table (see
 * scripts/gen-skillboard-layout.py). The id value does NOT encode the tier —
 * this table is the only ground truth for node placement.
 */
export const skillboardLayoutFor = (characterType: CharacterType): { key: SkillboardTierKey; ids: number[] }[] => {
  if (typeof characterType !== "string") return [];
  const board = (skillboardLayout as Record<string, Record<string, number[]>>)[characterType.toLowerCase()];
  if (!board) return [];
  return (["1", "2", "3", "ex"] as const)
    .filter((tier) => (board[tier]?.length ?? 0) > 0)
    .map((tier) => ({ key: tier === "ex" ? ("ex" as const) : (Number(tier) as 1 | 2 | 3), ids: board[tier] }));
};

/** The three master-trait branches, in the order the board shows them. */
export const SKILLBOARD_CATEGORIES = ["atk", "def", "lim"] as const;

export type SkillboardCategory = (typeof SKILLBOARD_CATEGORIES)[number];

/**
 * Points that must be spent in one category of a tier to activate that
 * category's bonus: 3 on Chaos I, 6 on Chaos II and III. EX has no activation
 * threshold, so it returns 0 (no progress pips are drawn for it).
 */
export const skillboardActivationCost = (tier: number | "ex"): number => (tier === "ex" ? 0 : tier === 1 ? 3 : 6);

export type ChecklistEntry = {
  /** Trait ids that count toward this entry (levels summed); ids[0] provides the display name. */
  ids: number[];
  /** Minimum combined level for the check to pass. */
  level: number;
};

export type ChecklistGroups = { build: ChecklistEntry[]; ai: ChecklistEntry[] };

/**
 * The shipped default checklist criteria (assets/checklist-default.json):
 * the endgame requirements shown in the Builds tab, checked against a
 * player's combined trait totals (wrightstone + summons + sigils). `build`
 * is the main sigils checklist; `ai` applies to AI-controlled party members
 * (no damage penalty from Glass Cannon). The JSON stores trait ids as the
 * lowercase hex strings used by the lang files; this converts them to the
 * numeric ids the parser emits.
 */
export const defaultChecklist = (): ChecklistGroups => {
  const parse = (entries: { ids: string[]; level: number }[]): ChecklistEntry[] =>
    entries.map((entry) => ({ ids: entry.ids.map((id) => parseInt(id, 16)), level: entry.level }));
  return { build: parse(checklistDefault.build), ai: parse(checklistDefault.ai) };
};

/**
 * The in-game sigil types, in the game's category order (skill.tbl category
 * 0-4, see scripts/gen-sigil-trait-categories.py). Basic = ATK / HP /
 * Critical Hit Rate / Stun Power — the category the DMG Cap skillboard node
 * counts ("+20% per Basic Stats-type sigil equipped (max sigils: 5)").
 */
export type SigilCategory = "basic" | "attack" | "defense" | "support" | "other";
const SIGIL_CATEGORIES: SigilCategory[] = ["basic", "attack", "defense", "support", "other"];

/** The in-game type of a sigil trait, or null for ids the game table doesn't know. */
export const sigilTraitCategory = (traitId: number): SigilCategory | null => {
  const category = (sigilTraitCategories as Record<string, number>)[toHashString(traitId)];
  return category === undefined ? null : SIGIL_CATEGORIES[category];
};

/**
 * A trait's maximum effective level — its effect stops scaling past this
 * (from the game's skill_status table, see scripts/gen-trait-max-levels.py).
 * Null for ids the table doesn't know.
 */
export const traitMaxLevel = (traitId: number): number | null =>
  (traitMaxLevels as Record<string, number>)[toHashString(traitId)] ?? null;

/** The Computed checklist rows all target 5 sigils of their type. */
export const SIGIL_CATEGORY_TARGET = 5;

/**
 * The equipped sigils of the given types. A sigil's type is its FIRST trait's
 * type — a matching second trait does not count.
 */
export const collectSigilsByCategory = (player: { sigils?: Sigil[] }, categories: SigilCategory[]): Sigil[] =>
  (player.sigils ?? []).filter((sigil) => {
    if (sigil.sigilId === EMPTY_ID) return false;
    const category = sigilTraitCategory(sigil.firstTraitId);
    return category !== null && categories.includes(category);
  });

/** A player's combined level toward a checklist entry (sum over the entry's id group). */
export const checklistLevel = (traits: CombinedTrait[], entry: ChecklistEntry): number =>
  traits.filter((trait) => entry.ids.includes(trait.id)).reduce((acc, trait) => acc + trait.level, 0);

export type ChecklistStatus = "missing" | "partial" | "met" | "over";

/**
 * missing: none at all; partial: some but under the target; met: exactly on
 * target; over: past the target (wasted levels — also worth a warning).
 */
export const checklistStatus = (level: number, required: number): ChecklistStatus => {
  if (level === 0) return "missing";
  if (level < required) return "partial";
  return level === required ? "met" : "over";
};

/**
 * The game's overcap-display percentage: `(ΣbaseSum / ΣcapSum) * 100`, aggregated
 * over cappable hits. A hit exactly at the cap contributes 100%, a hit twice the
 * cap contributes 200%. Returns `null` when there were no cappable hits (nothing to
 * divide by) so callers can render a placeholder instead of a bogus 0%.
 */
export const computeOvercapPercentage = (sums: { overcapBaseSum: number; overcapCapSum: number }): number | null => {
  if (sums.overcapCapSum <= 0) {
    return null;
  }
  return (sums.overcapBaseSum / sums.overcapCapSum) * 100;
};

export const epochToLocalTime = (epoch: number): string => {
  const utc = new Date(epoch);

  return new Intl.DateTimeFormat("default", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).format(utc);
};

/** DoT type payload -> i18n slug. Populated by the hook since the 2.0.2 fix; anything
 * outside this map (including every log recorded before it, which reports 0 for all
 * three) falls back to the unnamed "Damage Over Time" keys. */
const DOT_TYPE_SLUGS: Record<number, string> = { 0: "poison", 1: "burn", 2: "darkburn" };

/**
 * i18n key chain for one damage-over-time row, most specific first.
 *
 * A character's own `damage-over-time` override stays ahead of the generic type name:
 * Id's DoT is flavoured "Darkflame (DoT)", which reads better than "Darkburn".
 */
export const damageOverTimeKeys = (
  characterType: CharacterType,
  childCharacterType: CharacterType,
  dotType: number
): string[] => {
  const generic = [`skills.${childCharacterType}.damage-over-time`, `skills.${characterType}.damage-over-time`];
  const slug = DOT_TYPE_SLUGS[dotType];

  if (slug === undefined) {
    return [...generic, "skills.default.damage-over-time"];
  }

  return [
    `skills.${childCharacterType}.damage-over-time-${slug}`,
    `skills.${characterType}.damage-over-time-${slug}`,
    ...generic,
    `skills.default.damage-over-time-${slug}`,
    "skills.default.damage-over-time",
  ];
};

/** Every summon and primal-burst hit reports this one action id, so the id alone
 * can never name the row — the summon's body class is the only discriminator. */
export const SUMMON_ATTACK_ACTION_ID = 80000;

/** The label for a summon hit whose body class nothing names.
 *
 * Only summons with their OWN body class can be named. Most share one of two
 * generic bodies and collapse into a single row, which is why this has to stay:
 * naming that row after any one summon would be wrong. */
const SUMMON_FALLBACK_KEYS = [`skills.default.${SUMMON_ATTACK_ACTION_ID}`, "skills.default.unknown-skill"];

/** The body-class hash of a summon hit, or null when the source is a real
 * character rather than an unresolved `So####` body.
 *
 * The class arrives as an unresolved `{ Unknown: hash }` character type, since
 * `So####` bodies are not player characters. */
const summonBodyHash = (childCharacterType: CharacterType): string | null => {
  if (typeof childCharacterType !== "object" || !Object.hasOwn(childCharacterType, "Unknown")) return null;
  return childCharacterType.Unknown.toString(16).padStart(8, "0");
};

/** The mapped name for a summon body class, or null.
 *
 * Summons cannot ride the `t()` chain the way ability rows do: 62 of the 77
 * classes exist in `summons.json` only as tiered text ("Evyl Blackwyrm III"),
 * one body class covers every tier, and `t()` returns text verbatim. So read the
 * bundle directly — the shape `getLangBundle` establishes — and strip the suffix
 * here.
 */
export const summonDisplayName = (bodyClassHash: string): string | null => {
  const source = summonClassSource(bodyClassHash);
  if (source === null) return null;

  const text = getLangBundle(source.ns)[source.hash]?.text;
  if (!text) return null;

  return stripTierSuffix(text);
};

export const getSkillName = (characterType: CharacterType, skill: SkillState) => {
  switch (true) {
    case skill.actionType === "LinkAttack":
      return t([`skills.${characterType}.link-attack`, "skills.default.link-attack"]);
    case skill.actionType === "SBA":
      return t([`skills.${characterType}.skybound-arts`, "skills.default.skybound-arts"]);
    case skill.actionType === "PerfectGuard":
      return t([`skills.${characterType}.perfect-guard`, "skills.default.perfect-guard"]);
    case skill.actionType === "PerfectGuardQuickening":
      return t([`skills.${characterType}.perfect-guard-quickening`, "skills.default.perfect-guard-quickening"]);
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "StunEffect"): {
      const index = (skill.actionType as { StunEffect: number }).StunEffect;
      return t([`skills.${characterType}.stun-effect-${index}`, `skills.default.stun-effect-${index}`]);
    }
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "SupplementaryDamage"):
      return t(["skills.default.supplementary-damage"]);
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "DamageOverTime"):
      return t(
        damageOverTimeKeys(
          characterType,
          skill.childCharacterType,
          (skill.actionType as { DamageOverTime: number }).DamageOverTime
        )
      );
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "Normal"): {
      const actionType = skill.actionType as { Normal: number };
      const skillID = actionType["Normal"];

      if (skillID === SUMMON_ATTACK_ACTION_ID) {
        const bodyHash = summonBodyHash(skill.childCharacterType);
        const mapped = bodyHash === null ? null : summonDisplayName(bodyHash);
        if (mapped !== null) return mapped;

        return t(SUMMON_FALLBACK_KEYS, { id: skillID });
      }

      return t(
        [
          `skills.${skill.childCharacterType}.${skillID}`,
          `skills.${characterType}.${skillID}`,
          // The generated abilities bundle, via the bridge map: ui.json keys rows
          // by action id, abilities.json by ability hash. Sits behind the ui.json
          // keys so a hand-authored label still wins.
          ...abilitySourceKeys(String(characterType), String(skill.childCharacterType), skillID),
          `skills.default.${skillID}`,
          `skills.default.unknown-skill`,
        ],
        { id: skillID }
      );
    }
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "Group"): {
      const actionType = skill.actionType as { Group: string };

      return t(
        [
          `skills.${characterType}.skill-groups.${actionType.Group}`,
          `skills.default.skill-groups.${actionType.Group}`,
          `skills.default.unknown-skill`,
        ],
        { id: actionType.Group }
      );
    }
    default:
      return t("ui.unknown");
  }
};
const tryParseInt = (intString: string | number, defaultValue = 0) => {
  if (typeof intString === "number") {
    if (isNaN(intString)) return defaultValue;
    return intString;
  }

  let intNum;

  try {
    intNum = parseInt(intString);
    if (isNaN(intNum)) intNum = defaultValue;
  } catch {
    intNum = defaultValue;
  }

  return intNum;
};

/// Takes a number and returns a shortened version of it that is friendlier to read.
/// For example, 1200 would be returned as 1.2k, 1200000 as 1.2m, and so on.
export const humanizeNumbers = (n: number) => {
  // Keep the string from toFixed rather than coercing back to a number — the
  // coercion drops the trailing zero, so 400m rendered as "400m" next to "1.5m".
  if (n >= 1e3 && n < 1e6) return [(n / 1e3).toFixed(1), "k"];
  if (n >= 1e6 && n < 1e9) return [(n / 1e6).toFixed(1), "m"];
  if (n >= 1e9 && n < 1e12) return [(n / 1e9).toFixed(1), "b"];
  if (n >= 1e12) return [(n / 1e12).toFixed(1), "t"];
  else return [tryParseInt(n).toFixed(0), ""];
};

/// Takes a number of milliseconds and returns a string in the format of MM:SS.
export const millisecondsToElapsedFormat = (ms: number): string => {
  const date = new Date(Date.UTC(0, 0, 0, 0, 0, 0, ms));
  return `${date.getUTCMinutes().toString().padStart(2, "0")}:${date.getUTCSeconds().toString().padStart(2, "0")}`;
};

/// Captures a screenshot of the meter and copies it to the clipboard.
export const exportScreenshotToClipboard = (selector = ".app") => {
  const app = document.querySelector(selector) as HTMLElement;

  html2canvas(app, {
    backgroundColor: "#252525",
  }).then((canvas) => {
    canvas.toBlob((blob) => {
      if (blob) {
        const item = new ClipboardItem({ "image/png": blob });
        navigator.clipboard.write([item]).then(() => {
          toast.success(t("ui.copied-to-clipboard"));
        });
      }
    });
  });
};

/// Translates a character type hash to its localized class name (e.g. "Cagliostro").
export const translateCharacterType = (characterType: CharacterType): string =>
  t(`characters:${characterType}`, `ui:characters.${characterType}`);

/// Builds the `Name (CharacterType)` label shared by the meter and the equipment tab.
///
/// AI companions have their `displayName` blanked by the hook (their identity
/// snapshot carries the LOCAL player's name, which isn't theirs), so an empty name
/// on a resolved slot means "AI" — rendered as `CharacterType (AI)`. Real players
/// (local or remote) always carry a name. When `showName` is off (streamer mode) we
/// hide real names but must NOT mislabel them as AI, so the marker keys on the empty
/// name, not on the toggle.
export const formatCharacterLabel = (
  characterType: CharacterType,
  displayName: string,
  showName: boolean = true
): string => {
  const type = translateCharacterType(characterType);

  if (displayName === "") {
    return `${type} (${t("ui:characters.ai")})`;
  }

  return showName ? `${displayName} (${type})` : type;
};

/// Formats the player name and translates the player's character type.
export const translatedPlayerName = (
  partySlotIndex: number,
  partySlotData: PlayerData | null,
  player?: ComputedPlayerState,
  show_display_names: boolean = true
) => {
  if (!player) return "Guest";

  const name = partySlotData
    ? formatCharacterLabel(player.characterType, partySlotData.displayName, show_display_names)
    : translateCharacterType(player.characterType);

  return `[${partySlotData ? partySlotIndex + 1 : "Guest"}]` + " " + name;
};

export const sortPlayers = (players: ComputedPlayerState[], sortType: SortType, sortDirection: SortDirection) => {
  // Precompute the sort key once per player when it isn't a plain field on the state,
  // so the comparator doesn't re-derive it for every comparison (O(n log n) scans).
  const supEligible =
    sortType === MeterColumns.SupPercentage ? new Map(players.map((p) => [p, computeSupPercentage(p).eligible])) : null;

  players.sort((a, b) => {
    if (sortType === MeterColumns.Name) {
      return sortDirection === "asc" ? a.partyIndex - b.partyIndex : b.partyIndex - a.partyIndex;
    } else if (sortType === MeterColumns.DPS) {
      return sortDirection === "asc" ? a.dps - b.dps : b.dps - a.dps;
    } else if (sortType === MeterColumns.TotalDamage) {
      return sortDirection === "asc" ? a.totalDamage - b.totalDamage : b.totalDamage - a.totalDamage;
    } else if (sortType === MeterColumns.DamagePercentage) {
      return sortDirection === "asc" ? a?.percentage - b?.percentage : b?.percentage - a?.percentage;
    } else if (sortType === MeterColumns.SBA) {
      return sortDirection === "asc" ? a?.sba - b?.sba : b?.sba - a?.sba;
    } else if (sortType === MeterColumns.TotalStunValue) {
      return sortDirection === "asc" ? a?.totalStunValue - b?.totalStunValue : b?.totalStunValue - a?.totalStunValue;
    } else if (sortType === MeterColumns.StunPerSecond) {
      return sortDirection === "asc" ? a?.stunPerSecond - b?.stunPerSecond : b?.stunPerSecond - a?.stunPerSecond;
    } else if (sortType === MeterColumns.SupPercentage) {
      const ea = supEligible!.get(a)!;
      const eb = supEligible!.get(b)!;
      return sortDirection === "asc" ? ea - eb : eb - ea;
    }

    return 0;
  });
};

/// Exports the character data to the clipboard in a detailed format (JSON)
export const exportCharacterDataToClipboard = (playerData: PlayerData) => {
  navigator.clipboard.writeText(JSON.stringify(playerData)).then(() => {
    toast.success(t("ui.copied-to-clipboard"));
  });
};

/// Exports the character data to the the Relink Damage Calculator application.
export const openDamageCalculator = (playerData: PlayerData) => {
  const data = jsurl.stringify(playerData);

  open(`https://relink-damage.vercel.app/?logsdata=${data}`);
};

/// Exports the encounter data to the clipboard in a simple format (CSV)
export const exportSimpleEncounterToClipboard = (
  sortType: SortType,
  sortDirection: SortDirection,
  encounterState: EncounterState,
  partyData: Array<PlayerData | null>
) => {
  if (encounterState.totalDamage === 0) return toast.error("Nothing to copy!");

  const encounterHeader = "Encounter Time, Total Damage, Total DPS";
  const encounterValues = [
    millisecondsToElapsedFormat(encounterState.endTime - encounterState.startTime),
    encounterState.totalDamage,
    Math.round(encounterState.dps),
  ].join(", ");

  const encounterData = [encounterHeader, encounterValues].join("\n");

  const orderedPlayers = formatInPartyOrder(encounterState.party);

  const players: Array<ComputedPlayerState> = orderedPlayers.map((playerData) => {
    return {
      ...playerData,
      percentage: (playerData.totalDamage / encounterState.totalDamage) * 100,
    };
  });

  sortPlayers(players, sortType, sortDirection);

  const playerHeader = "Name, DMG, DPS, %";
  const playerData = players
    .map((player) => {
      const totalDamage = player.skillBreakdown.reduce((acc, skill) => acc + skill.totalDamage, 0);
      const computedSkills = player.skillBreakdown.map((skill) => {
        return {
          // Guard the denominator: a guard-only player (all zero-damage Perfect
          // Guard rows) has totalDamage 0, which would export "NaN%" for every
          // row — same guard as useSkillBreakdown.
          percentage: totalDamage > 0 ? (skill.totalDamage / totalDamage) * 100 : 0,
          ...skill,
        };
      });

      computedSkills.sort((a, b) => b.totalDamage - a.totalDamage);

      const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);

      return [
        translatedPlayerName(partySlotIndex, partyData[partySlotIndex], player),
        player.totalDamage,
        Math.round(player.dps),
        `${player.percentage?.toFixed(2)}%`,
      ].join(", ");
    })
    .join("\n");

  navigator.clipboard.writeText([encounterData, playerHeader, playerData].join("\n")).then(() => {
    toast.success(t("ui.copied-to-clipboard"));
  });
};

/// Exports the encounter data to the clipboard in a detailed format (CSV)
export const exportFullEncounterToClipboard = (
  sortType: SortType,
  sortDirection: SortDirection,
  encounterState: EncounterState,
  partyData: Array<PlayerData | null>
) => {
  if (encounterState.totalDamage === 0) return toast.error("Nothing to copy!");

  const encounterHeader = "Encounter Time, Total Damage, Total DPS";
  const encounterValues = [
    millisecondsToElapsedFormat(encounterState.endTime - encounterState.startTime),
    encounterState.totalDamage,
    Math.round(encounterState.dps),
  ].join(", ");

  const encounterData = [encounterHeader, encounterValues].join("\n");

  const playerHeader = "Name, DMG, DPS, %";
  const orderedPlayers = formatInPartyOrder(encounterState.party);

  const players: Array<ComputedPlayerState> = orderedPlayers.map((playerData) => {
    return {
      ...playerData,
      percentage: (playerData.totalDamage / encounterState.totalDamage) * 100,
    };
  });

  sortPlayers(players, sortType, sortDirection);

  const playerData = players
    .map((player) => {
      const totalDamage = player.skillBreakdown.reduce((acc, skill) => acc + skill.totalDamage, 0);
      const computedSkills = player.skillBreakdown.map((skill) => {
        return {
          // Guard the denominator: a guard-only player (all zero-damage Perfect
          // Guard rows) has totalDamage 0, which would export "NaN%" for every
          // row — same guard as useSkillBreakdown.
          percentage: totalDamage > 0 ? (skill.totalDamage / totalDamage) * 100 : 0,
          ...skill,
        };
      });

      const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);

      computedSkills.sort((a, b) => b.totalDamage - a.totalDamage);

      const playerLine = [
        translatedPlayerName(partySlotIndex, partyData[partySlotIndex], player),
        player.totalDamage,
        Math.round(player.dps),
        `${player.percentage?.toFixed(2)}%`,
      ].join(", ");

      const skillHeader = ["Skill", "Hits", "Total", "Min", "Max", "Avg", "%"].join(", ");

      const skillLine = computedSkills
        .map((skill) => {
          const skillName = getSkillName(player.characterType, skill);
          const averageHit = skill.hits === 0 ? 0 : skill.totalDamage / skill.hits;

          return [
            skillName,
            skill.hits,
            skill.totalDamage,
            skill.minDamage,
            skill.maxDamage,
            Math.round(averageHit),
            `${skill.percentage.toFixed(2)}%`,
          ].join(", ");
        })
        .join("\n");

      return [playerHeader, playerLine, skillHeader, skillLine].join("\n");
    })
    .join("\n");

  navigator.clipboard.writeText([encounterData, playerData].join("\n")).then(() => {
    toast.success(t("ui.copied-to-clipboard"));
  });
};

export const PLAYER_COLORS = ["#FF5630", "#FFAB00", "#36B37E", "#00B8D9", "#9BCF53", "#380E7F", "#416D19", "#2C568D"];

/// Resolves a player row's chart/overlay color. A filled party slot's color belongs
/// to the row matched to it. A row that doesn't resolve to a slot picks, by its sort
/// position, from the remaining colors: first the EMPTY slots' colors (so four
/// characters still use colors 1-4 even when some identities are missing), then the
/// overflow colors. Indexing the slot palette by sort position would collide with
/// matched rows' colors, so unmatched rows draw from `freeColors` instead.
///
/// `colors` is the 8-entry palette (the four user colors + `PLAYER_COLORS.slice(4)`).
export const resolvePlayerColor = (
  colors: string[],
  partyData: Array<PlayerData | null>,
  partySlotIndex: number,
  sortIndex: number
): string => {
  if (partySlotIndex !== -1) return colors[partySlotIndex];
  const freeColors = colors.filter((_, i) => i >= 4 || !partyData[i]);
  return freeColors[sortIndex % freeColors.length];
};

/// Style for a meter row's damage bar, painted as the row's own background
/// (see .player-row/.skill-row in App.css). The bar must NOT be a positioned
/// child element: relative/z-index layering on table internals is undefined
/// CSS that WebKitGTK (Linux) resolves by painting the bar over the cell text.
export const damageBarStyle = (color: string, percentage: number): CSSProperties => {
  const width = Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
  return {
    "--damage-bar-color": color,
    "--damage-bar-width": `${width}%`,
  } as CSSProperties;
};

/// Translates the enemy type to a human-readable string.
export const translateEnemyType = (type: EnemyType | null): string => {
  if (type === null) return "";

  if (typeof type == "object" && Object.hasOwn(type, "Unknown")) {
    const hash = type.Unknown.toString(16).padStart(8, "0");

    return t([`enemies:${hash}.text`, `enemies.unknown.${hash}`, "enemies.unknown-type"], { id: hash });
  } else {
    return t([`enemies.${type}`, "enemies.unknown-type"]);
  }
};

export const translateEnemyTypeId = (id: number): string => {
  const hash = toHashString(id);
  return t([`enemies:${hash}.text`, `enemies.unknown.${hash}`, "enemies.unknown-type"], { id: hash });
};

// A string form usable as a map key ("Em1000" and { Unknown: 0x1234 } stay distinct).
const enemyTypeKey = (type: EnemyType): string => (typeof type === "string" ? `s:${type}` : `h:${type.Unknown}`);

/** Key for one target spawn segment, shared by the quest-view HP chart and the target
 * filter so they can never disagree on a label.
 *
 * Keyed on the enemy TYPE, never on its translated name: `instance` is numbered per type,
 * and en/enemies.json has 19 display names shared by two or three distinct type hashes
 * (Fotia, Anemos, Edafos, Hydor, the Goblin variants — exactly the summon-heavy fights
 * this chart is for). A name-based key collapsed those into one entry, so one pool's HP
 * line silently overwrote another's. */
export const targetLabelKey = (enemyType: EnemyType, instance: number): string =>
  `${enemyTypeKey(enemyType)}#${instance}`;

/** Stable empty breakdown for live rows: the meter re-renders on every tick, and
 * a fresh `[]` each time would invalidate the tooltip's `breakdown` memo and force
 * it to rebuild its element tree only to be discarded. Sharing one reference keeps
 * that memo cached. Never mutate. */
export const NO_TARGETS: SkillTargetState[] = [];

/** Merge per-enemy skill breakdowns — one array per skill, `undefined` for
 * skills from logs saved before the breakdown existed — summing hits and
 * damage by enemy type, sorted by damage descending. Used by the quest-view
 * skill tooltips (a condensed group merges its member skills). */
export const mergeTargetBreakdowns = (breakdowns: (SkillTargetState[] | undefined)[]): SkillTargetState[] => {
  const merged = new Map<string, SkillTargetState>();
  for (const breakdown of breakdowns) {
    for (const target of breakdown ?? []) {
      const key = enemyTypeKey(target.enemyType);
      const entry = merged.get(key);
      if (entry) {
        entry.hits += target.hits;
        entry.totalDamage += target.totalDamage;
      } else {
        merged.set(key, { ...target });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.totalDamage - a.totalDamage);
};

/// Translates the quest ID to a human-readable string.
export const translateQuestId = (id: number | null): string => {
  if (id === null) return "";
  const hash = id.toString(16);
  return t([`quests:${hash}.text`, "quest.unknown"], { id: hash });
};

/** A loaded resource bundle: active language first, `en` filling in (matches
 * i18next fallback), `{}` when neither is loaded yet. */
export const getLangBundle = (namespace: string): Record<string, { text?: string }> =>
  (i18next.getResourceBundle(i18next.language, namespace) ??
    i18next.getResourceBundle("en", namespace) ??
    {}) as Record<string, { text?: string }>;

/** The loaded `traits` resource bundle. */
export const getTraitsBundle = (): Record<string, { text?: string }> => getLangBundle("traits");

/// Translates the trait ID to a human-readable string.
export const translateTraitId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`traits:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the ability (equipped skill) ID to a human-readable string.
export const translateAbilityId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`abilities:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the sigil ID to a human-readable string.
export const translateSigilId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`sigils:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the item ID to a human-readable string.
export const translateItemId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`items:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/** The wrightstone's display name. The stone's ITEM id never syncs for remote
 * players (only its trait pairs do), so 0 means "a stone we can't name", not
 * "Unknown (00000000)" — fall back to the generic label. */
export const translateWrightstoneId = (id: number | null): string =>
  id && id !== EMPTY_ID ? translateItemId(id) : t("ui.wrightstone");

/// Translates the overmastery ID to a human-readable string.
export const translateOvermasteryId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");

  return t([`overmasteries:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates a numeric weapon ID (weapon table key hash) to a human-readable string.
export const translateWeaponId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`weapons:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the summon ID (summon table key) to a human-readable string.
export const translateSummonId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`summons:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the summon equip-bonus ID (summon base-param key) to a human-readable string.
export const translateSummonBonusId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`summon-bonuses:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// The skillboard bundle key for one master-trait node. Node ids are only unique
/// per character (the game's effect/ui id), so the key composes both:
/// ("Pl2700", 10) -> "pl2700_000a". Unresolved character types can't match any
/// bundle entry, so they key to the unknown fallback.
export const skillboardNodeKey = (characterType: CharacterType, id: number): string => {
  const character = typeof characterType === "string" ? characterType.toLowerCase() : "unknown";
  return `${character}_${id.toString(16).padStart(4, "0")}`;
};

/// The character's in-game name for one master-trait branch, prefix included
/// ("Essence: Lightning Soldier") — every character names its three branches
/// differently. Falls back to `fallbackKey` (the generic branch name) for
/// characters the bundle doesn't cover, e.g. one added by a game update.
export const translateSkillboardBranch = (
  characterType: CharacterType,
  category: SkillboardCategory,
  fallbackKey: string
): string => {
  if (typeof characterType !== "string") return t(fallbackKey);
  return t([`skillboard-branches:${characterType.toLowerCase()}_${category}.text`, fallbackKey]);
};

/// Translates one skillboard (master trait) node of a character to its
/// human-readable effect text (e.g. "Charged Attacks: Charge Time -5%").
export const translateSkillboardNode = (characterType: CharacterType, id: number): string => {
  const key = skillboardNodeKey(characterType, id);
  return t([`skillboard:${key}.text`, "ui.unknown-id"], { id: key });
};

export type SkillboardNodeMeta = { category: "def" | "atk" | "lim"; tier: number | "ex" };

/// Decodes the board position a skillboard node id encodes (verified against
/// skillboard_layout across all 29 characters): hundreds digit = category
/// (0 defense, 1 attack, 2 limit); the remainder is 0-2 for a tier's special
/// node, 10-49 for Chaos tier `tens digit` nodes, and 50+ for the EX group.
export const skillboardNodeMeta = (id: number): SkillboardNodeMeta | null => {
  const category = (["def", "atk", "lim"] as const)[Math.floor(id / 100)];
  if (!category) return null;

  const sub = id % 100;
  if (sub >= 50) return { category, tier: "ex" };
  if (sub >= 10) return { category, tier: Math.floor(sub / 10) };
  return sub <= 2 ? { category, tier: sub + 1 } : null;
};

// Reverse index for translateWeaponKey/weaponKeyHash, rebuilt when the language
// changes: the hook reports the equipped weapon as its game KEY NAME (e.g.
// "WEP_PL2700_02_01"), while the weapons bundle is keyed by hash — but each
// entry carries its `key` name, so a scan over the bundle bridges the two
// without hashing.
const weaponByKey = new Map<string, { text: string; hash: string }>();
let weaponByKeyLang: string | null = null;

const weaponEntryForKey = (key: string): { text: string; hash: string } | undefined => {
  if (!key) return undefined;
  const lang = i18next.language || "en";
  if (weaponByKeyLang !== lang) {
    weaponByKey.clear();
    weaponByKeyLang = lang;
    // Active language first; en fills the gaps (matches i18next fallback).
    for (const bundle of [i18next.getResourceBundle(lang, "weapons"), i18next.getResourceBundle("en", "weapons")]) {
      if (!bundle) continue;
      for (const [hash, entry] of Object.entries(bundle) as Array<[string, { key?: string; text?: string }]>) {
        if (entry?.key && entry?.text && !weaponByKey.has(entry.key)) {
          weaponByKey.set(entry.key, { text: entry.text, hash });
        }
      }
    }
  }
  // Uncap variants are not always separate weapon.tbl rows (e.g. the hook reports
  // WEP_PL2700_02_01 but only WEP_PL2700_02 is named) — fall back to the base weapon.
  return weaponByKey.get(key) ?? weaponByKey.get(key.replace(/_\d+$/, ""));
};

/// Translates a weapon key name (e.g. "WEP_PL2700_02_01") to a human-readable
/// string, falling back to the raw key when no translation exists.
export const translateWeaponKey = (key: string): string => weaponEntryForKey(key)?.text ?? key;

export type WeaponTraitDef = {
  /// Trait id as an 8-hex hash string (same id space as the `traits:` bundle).
  id: string;
  /// Trait level by weapon uncap tier (0..6); 0 = not yet unlocked.
  uncap: number[];
  /// Trait level by awakening tier (0..3) for awakening-granted skills.
  awakening: number[];
  /// True when the skill only exists on awakened weapons.
  isAwakening: boolean;
};

/// The weapon's innate weapon-skill (trait) definitions from the static
/// weapon-traits asset (see scripts/gen-weapon-traits.py), resolved via the
/// weapons bundle's key→hash bridge with the same base-weapon fallback as
/// translateWeaponKey. Empty when the weapon (or asset row) is unknown.
export const weaponInnateTraits = (key: string): WeaponTraitDef[] => {
  const hash = weaponEntryForKey(key)?.hash;
  if (!hash) return [];
  return (weaponTraitsData as Record<string, WeaponTraitDef[]>)[hash] ?? [];
};

type TranscendenceSlot = {
  /// Skill id hash of the slot's BASE skill — live innate ids can be the
  /// upgrade-resolved variant instead, hence the positional fallback below.
  id: string;
  /// The skill's level per transcendence stage, right-aligned to the 10-stage
  /// display scale: a curve whose last nonzero value sits at index N covers
  /// display stages (10-N)..10. 0 = stage not defined for this weapon.
  levels: number[];
};

/**
 * The weapon's transcendence ("rebuild"/Transcension) stage on the in-game
 * 0-10 scale, derived by locating each live innate-skill level inside the
 * weapon's per-stage level curves (weapon-transcendence.json, see
 * scripts/gen-weapon-transcendence.py) and intersecting the candidates.
 * Null when the weapon has no curves, no trait carries a level (pre-fix
 * logs), or the levels don't pin a unique stage (e.g. only flat curves).
 */
export const deriveTranscendence = (weaponId: number, innateTraits: { id: number; level: number }[]): number | null => {
  const slots = (weaponTranscendenceData as Record<string, TranscendenceSlot[]>)[toHashString(weaponId)];
  if (!slots) return null;

  let candidates: Set<number> | null = null;
  innateTraits.forEach((trait, index) => {
    if (trait.level <= 0) return;
    const slot = slots.find((s) => s.id === toHashString(trait.id)) ?? slots[index];
    if (!slot) return;
    const lastDefined = slot.levels.reduce((acc, level, i) => (level > 0 ? i : acc), -1);
    if (lastDefined < 0) return;
    const offset = 10 - lastDefined;
    const stages = new Set(
      slot.levels.flatMap((level, i) => (level === trait.level && i <= lastDefined ? [i + offset] : []))
    );
    if (stages.size === 0) return; // level not on this curve — data drift, don't poison the intersection
    candidates = candidates === null ? stages : new Set([...candidates].filter((stage) => stages.has(stage)));
  });

  return candidates !== null && (candidates as Set<number>).size === 1 ? [...(candidates as Set<number>)][0] : null;
};

/// Converts a number to a hexadecimal string.
export const toHash = (num: number): string => num.toString(16);

/// Converts a number to a hexadecimal string and pads it to 8 characters.
export const toHashString = (num: number | undefined): string => (num ? num.toString(16).padStart(8, "0") : "");

/** Active/highlight state for the logs-window navigation, derived from the router
 * pathname. The header tabs (Logs / Toolbox / Settings) are mutually exclusive;
 * "Logs" covers everything that isn't toolbox/settings (list, detail, conflux).
 * Quests/Conflux are the body sub-tabs shown only on the two list pages. */
export const deriveNavState = (pathname: string) => {
  const toolboxActive = pathname.startsWith("/logs/toolbox");
  const settingsActive = pathname.startsWith("/logs/settings");
  const debugActive = pathname.startsWith("/logs/debug");
  const logsActive = !toolboxActive && !settingsActive && !debugActive;
  const confluxActive = pathname.startsWith("/logs/conflux");
  const questsActive = logsActive && !confluxActive;
  const onListPage = pathname === "/logs" || confluxActive;
  return { logsActive, toolboxActive, settingsActive, debugActive, confluxActive, questsActive, onListPage };
};

/// Hook that returns the previous value of a variable.
export const usePrevious = <T>(value: T): T | undefined => {
  const ref = useRef<T>();

  useEffect(() => {
    ref.current = value;
  });

  return ref.current;
};
