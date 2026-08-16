import { open } from "@tauri-apps/api/shell";
import html2canvas from "html2canvas";
import * as jsurl from "jsurl";
import toast from "react-hot-toast";
import {
  CharacterType,
  ComputedPlayerState,
  ComputedSkillGroup,
  ComputedSkillState,
  EncounterState,
  EnemyState,
  EnemyType,
  MeterColumns,
  PlayerData,
  PlayerState,
  Sigil,
  SkillRow,
  SkillState,
  SkillTargetState,
  SortDirection,
  SortType,
} from "./types";

import checklistDefault from "@/assets/checklist-default.json";
import sigilTraitCategories from "@/assets/sigil-trait-categories.json";
import skillboardLayout from "@/assets/skillboard-layout.json";
import traitMaxLevels from "@/assets/trait-max-levels.json";
import weaponTraitsData from "@/assets/weapon-traits.json";
import weaponTranscendenceData from "@/assets/weapon-transcendence.json";
import i18next, { t } from "i18next";
import { useEffect, useRef, type CSSProperties } from "react";
import summonBonusValues from "../src-tauri/assets/summon-bonus-values.json";

import { renderTemplate } from "./labelTemplate";
import { resolveSkillName, stripTierSuffix, summonClassSource } from "./skillNameSources";
import { DEFAULT_PLAYER_LABEL, type BarFillMode } from "./stores/useMeterSettingsStore";

export const EMPTY_ID = 2289754288;

/** An empty slot arrives as either a plain zero or the engine's sentinel, so
 * both must count as empty — the same contract as `legality::is_empty` on the
 * Rust side. Prefer this over a bare `=== EMPTY_ID`, which misses the zero. */
export const isEmptyId = (id: number): boolean => id === 0 || id === EMPTY_ID;

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
 * Whether a breakdown row is a frontend-merged group rather than a single skill.
 *
 * Narrows `actionType` too, so callers get `row.actionType.Group` without
 * re-casting — the shape test and the cast were previously written out
 * separately at each use.
 */
export const isSkillGroup = (
  row: ComputedSkillGroup | ComputedSkillState
): row is ComputedSkillGroup & { actionType: { Group: string } } => hasGroupAction(row);

/** The group test on its own, over the two fields any hit carries.
 *
 * `isSkillGroup` narrows to a full `ComputedSkillGroup`, which is only truthful
 * for the rows the breakdown builds; callers holding a bare `SkillRow` need the
 * same shape test without that promise. Both spell it once, here. */
const hasGroupAction = (row: SkillRow): row is SkillRow & { actionType: { Group: string } } =>
  typeof row.actionType === "object" && Object.hasOwn(row.actionType, "Group");

/** Bodies that swing on a player's behalf but are not the player: Ferry's
 * ghosts (Geegee/Beebee/Kikiriki/Nicola) and her Umlauf satellite.
 *
 * Named bodies only. A player wearing a different body is still the player —
 * Id's transformation (`Pl2000`) and Cagliostro's clone both proc supplementary
 * damage normally, and the game logs each proc under the body that earned it,
 * which is how these two lists were told apart. */
const COMPANION_BODIES: readonly string[] = ["Pl0700Ghost", "Pl0700GhostSatellite"];

/**
 * Whether a hit came from something fighting alongside the player rather than
 * from the player's own body: a called summon, a Primal Burst, or one of
 * Ferry's named pets.
 *
 * One question with one answer. The three tests were asked separately at the
 * one call site that needed them, which left the concept unnamed and gave the
 * next metric that wants it nothing to call.
 */
export const isCompanionHit = (skill: SkillRow): boolean => {
  if (isSummonHit(skill)) return true;
  if (hasGroupAction(skill) && skill.actionType.Group === PRIMAL_BURST_GROUP) return true;

  return COMPANION_BODIES.includes(String(skill.childCharacterType));
};

/**
 * Whether a breakdown row's damage belongs in the Sup% eligible base.
 *
 * Only a player's own Normal skill hits can trigger supplementary damage. Link
 * Attacks, Skybound Arts and damage-over-time cannot, and neither can the
 * companions: pets and summons deal Normal-typed damage but no proc is ever
 * logged under either, so counting their damage only dilutes the number.
 * (Groups are frontend merges of Normal skills, scoped to the body they came
 * from, so the same two tests apply.)
 */
export const isSupEligibleRow = (skill: SkillRow): boolean => {
  const { actionType } = skill;
  if (typeof actionType !== "object") return false;
  if (!Object.hasOwn(actionType, "Normal") && !hasGroupAction(skill)) return false;

  return !isCompanionHit(skill);
};

export type SupPercentages = {
  /** Supp damage relative to supp-eligible (Normal skill) damage — the proc-quality
   * number. Each source procs at +20% of the trigger hit, so with all three equipped
   * and a 100% proc rate this tops out at +60%. */
  eligible: number;
  /** Supp damage as a share of the player's total damage, ineligible sources
   * (Link Attack, SBA, DoT, pets, summons) included. */
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
    } else if (isSupEligibleRow(skill)) {
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

/** The single-bit level flag (bit N → level N+1) → a 1-based level, or 0 if
 * unset. `>>> 0` forces the isolated bit to an unsigned value so a set bit 31
 * can't make `flags & -flags` negative and yield `Math.log2(negative) === NaN`. */
export const overmasteryLevel = (flags: number): number => (flags === 0 ? 0 : Math.log2((flags & -flags) >>> 0) + 1);

/** v2.0.2: overmasteries recovered from the town loadout carry only id + level
 * (in `flags`), not the computed in-game magnitude (`value` is 0) — fall back
 * to the level, matching the "(Lvl. N)" style used for sigils and summons. */
export const overmasteryAmount = (overmastery: { id: number; value: number; flags: number }): BonusAmount =>
  overmastery.value === 0
    ? { kind: "level", amount: overmasteryLevel(overmastery.flags) }
    : overmasteryAmountFromId(overmastery.id, overmastery.value);

/**
 * An overmastery as the equipment and builds tabs write it — `Critical Hit
 * Rate Up: +20%`, or `… (Lvl. 3)` when only the level survived.
 *
 * Shared rather than per-page: the audit page printed a bare `20` where `+20%`
 * belonged because it formatted the raw value itself, and a number without its
 * unit is not a claim anyone can check.
 */
export const formatOvermastery = (overmastery: { id: number; value: number; flags: number } | undefined): string => {
  if (!overmastery) return "";
  const translation = translateOvermasteryId(overmastery.id);
  const amount = overmasteryAmount(overmastery);
  return amount.kind === "level"
    ? `${translation} ${formatBonusAmount(amount)}`
    : `${translation}: ${formatBonusAmount(amount)}`;
};

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

/** "custom" groups hold user-editable entries; the single "computed" group
 * renders the derived sigil-category rows, whose entries the user cannot
 * change. */
export type ChecklistGroupKind = "custom" | "computed";

/** A checklist group as shipped in the defaults asset, before the store adds
 * the user's own flags (enabled, manualOrder, name). */
export type ChecklistGroupDef = {
  /** Stable key: "build" | "computed" | "ai" for seeded groups, "g-<n>" for new ones. */
  id: string;
  /** i18n key for a seeded group's name; cleared once the user renames it. */
  nameKey?: string;
  kind: ChecklistGroupKind;
  entries: ChecklistEntry[];
};

/**
 * The shipped default checklist criteria (assets/checklist-default.json):
 * the endgame requirements shown in the Builds tab, checked against a
 * player's combined trait totals (wrightstone + summons + sigils). The seeded
 * groups are the main sigils checklist, the derived sigil-category rows, and
 * one for AI-controlled party members (no damage penalty from Glass Cannon).
 * The JSON stores trait ids as the lowercase hex strings used by the lang
 * files; this converts them to the numeric ids the parser emits.
 */
export const defaultChecklist = (): ChecklistGroupDef[] =>
  (
    checklistDefault.groups as {
      id: string;
      nameKey: string;
      kind: string;
      entries: { ids: string[]; level: number }[];
    }[]
  ).map((group) => ({
    id: group.id,
    nameKey: group.nameKey,
    kind: group.kind as ChecklistGroupKind,
    entries: group.entries.map((entry) => ({ ids: entry.ids.map((id) => parseInt(id, 16)), level: entry.level })),
  }));

/** A copy of `items` with the element at `from` moved to `to`. Out-of-range or
 * no-op moves return the input unchanged, so a stray drag cannot corrupt a list. */
export const moveItem = <T>(items: T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/** One reusable collator rather than a fresh one per `localeCompare` call —
 * these sorts run per render over lists that grow with the user's config. */
const nameCollator = new Intl.Collator();

/**
 * A group's entries in display order. Order is resolved here, at render,
 * rather than stored: the traits bundle loads asynchronously (src/i18n.ts), so
 * names are not resolvable when the persisted store rehydrates, and the
 * alphabetical order a user expects is the one in their own language.
 */
export const orderedChecklistEntries = <T extends ChecklistEntry>(entries: T[], manualOrder: boolean): T[] => {
  if (manualOrder) return entries;
  // Each name is translated once and carried through the sort: comparing on
  // the fly would run two i18next lookups per comparison, i.e. O(n log n)
  // lookups for n entries. t() yields undefined before i18next has
  // initialized; an entry whose name cannot be resolved sorts first rather
  // than throwing mid-render.
  return entries
    .map((entry) => ({ entry, name: translateTraitId(entry.ids[0]) ?? "" }))
    .sort((a, b) => nameCollator.compare(a.name, b.name))
    .map(({ entry }) => entry);
};

/** A group's display name: a user-set literal beats the seeded i18n key, which
 * beats the raw id. Shared so the Builds tab and the settings editor cannot
 * disagree about what a group is called. */
export const checklistGroupName = (group: { id: string; name?: string; nameKey?: string }): string =>
  group.name ?? (group.nameKey ? t(group.nameKey) : group.id);

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

/** The derived rows the computed checklist group stands for, in display order.
 * Shared by the Builds tab (which renders them against a player's sigils) and
 * the settings editor (which previews them as disabled rows), so the two views
 * of the same group cannot list different rows. */
export const COMPUTED_SIGIL_ROWS: { label: string; categories: SigilCategory[] }[] = [
  { label: "ui.checklist.basic-sigils", categories: ["basic"] },
  { label: "ui.checklist.attack-sigils", categories: ["attack"] },
  { label: "ui.checklist.defense-support-sigils", categories: ["defense", "support"] },
];

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

/** The generated lang namespace keyed by summon body-class hash
 * (`lang/<locale>/summon-classes.json`, written by GBFRDataTools' `gen-langfiles`).
 * Same name as the bridge map's block because both mean "keyed by body class";
 * this one needs no bridge, being keyed by the hash a hit already carries. */
export const SUMMON_CLASSES_NAMESPACE = "summon-classes";

/** The generated lang namespace of Primal Burst attack names, keyed by the same
 * body-class hash (`TXT_SMN_So####_ASCE` rows). Exactly three classes have one —
 * which is what makes those three the Primal Burst beasts. */
export const PRIMAL_BURSTS_NAMESPACE = "primal-bursts";

/** The label for a summon hit whose body class nothing names.
 *
 * Only summons with their OWN body class can be named. Most share one of two
 * generic bodies and collapse into a single row, which is why this has to stay:
 * naming that row after any one summon would be wrong. */
const SUMMON_FALLBACK_KEYS = [`skills.default.${SUMMON_ATTACK_ACTION_ID}`, "skills.default.unknown-skill"];

/** The body classes a Primal Burst is dealt by — `So0300` Proto Bahamut,
 * `So0400` Proto Bahamut, Transcendent Blue and `So0500` Excavallion.
 *
 * What marks exactly these three: they are the only summon classes carrying a
 * `TXT_SMN_So####_ASCE` burst-attack row (Catastrophe / Azure Ruin / Desert
 * Flare), and the only ones with no `summon.tbl` row — they cannot be equipped
 * and called like an ordinary summon, so their damage IS the burst. Mirrors
 * `LangCategoryRules.PrimalBursts`; kept as a literal so grouping survives a
 * locale whose generated bundle has not loaded yet.
 *
 * Grouped into one row because which beast answers a burst is incidental —
 * what the meter is reporting is the Primal Burst. */
export const PRIMAL_BURST_CLASSES: readonly string[] = ["5418b8f8", "32776c5b", "870a9dfe"];

/** The skill-group key the three bodies condense into. */
export const PRIMAL_BURST_GROUP = "primal-burst";

/** The body-class hash of a called summon's hit, or null when the hit is not
 * one: every summon reports the same shared summon-attack action from an
 * unresolved `So####` body, which is what separates a summon from a player's
 * own alternate body.
 *
 * Answers with the hash rather than a boolean so a caller that needs to know
 * WHICH summon does not re-run the test to find out. */
const summonHitBodyHash = (skill: SkillRow): string | null => {
  if (typeof skill.actionType !== "object" || !Object.hasOwn(skill.actionType, "Normal")) return null;
  if ((skill.actionType as { Normal: number }).Normal !== SUMMON_ATTACK_ACTION_ID) return null;

  return summonBodyHash(skill.childCharacterType);
};

/** True for a hit dealt by a called summon. */
export const isSummonHit = (skill: SkillRow): boolean => summonHitBodyHash(skill) !== null;

/** True for a summon hit dealt by one of the Primal Burst bodies. Owns the
 * hash-format detail (lowercase, zero-padded to eight) so callers never
 * re-derive it. */
export const isPrimalBurstHit = (skill: SkillRow): boolean => {
  const bodyHash = summonHitBodyHash(skill);

  return bodyHash !== null && PRIMAL_BURST_CLASSES.includes(bodyHash);
};

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
  // A Primal Burst is named after the burst, not the beast: So0300's class row
  // reads "Proto Bahamut", but what the player just watched is "Catastrophe".
  const burst = getLangBundle(PRIMAL_BURSTS_NAMESPACE)[bodyClassHash]?.text;
  if (burst) return stripTierSuffix(burst);

  // The generated class table is keyed by exactly what a hit reports, so it
  // needs no bridge hop and covers all 77 classes. The bridge below still owns
  // the two unit-variant ids (So4502, So5f01) that have no class row.
  const fromClassTable = getLangBundle(SUMMON_CLASSES_NAMESPACE)[bodyClassHash]?.text;
  if (fromClassTable) return stripTierSuffix(fromClassTable);

  const source = summonClassSource(bodyClassHash);
  if (source === null) return null;

  const text = getLangBundle(source.ns)[source.hash]?.text;
  if (!text) return null;

  return stripTierSuffix(text);
};

export const getSkillName = (characterType: CharacterType, skill: SkillRow) => {
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

      // ui.json labels and the bridge's game names, in the order the
      // skill_name_resolution mode dictates — labels ahead of every bridge
      // name by default; see SkillNameResolutionMode.
      const resolved = resolveSkillName([String(skill.childCharacterType), String(characterType)], skillID);
      if (resolved !== null) return resolved;

      return t([`skills.default.${skillID}`, `skills.default.unknown-skill`], { id: skillID });
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

/** Name for a status row's cause id, or empty when no table names it.
 *
 * A cause in the character bands is the applying character's action id, so it
 * resolves through the same language-major lookup the damage meter uses —
 * every candidate character's table then bridge entry per language (the row's
 * CASTERS — see `causeCandidatesFor`), then the `causes.default` band entries
 * (sigil/trait, equipment, environment, perfect guard).
 *
 * `causes.default`, never `skills.default`: the shared skills table names the
 * DAMAGE id space, and the two spaces only coincide within one character's own
 * band. Its 99999 is the conflux effect action, while cause 99999 arrives
 * under Shield in quests with no conflux at all — a cause band the shared
 * damage table would name wrongly. */
export const causeSkillName = (candidates: CharacterType[], causeId: number): string => {
  const probe = (id: number): string => {
    // The same label/bridge resolution the damage rows use, mode included.
    const resolved = resolveSkillName(candidates.map(String), id);
    return resolved ?? t(`causes.default.${id}`, { defaultValue: "" });
  };
  const exact = probe(causeId);
  if (exact) return exact;
  // The game numbers action variants within a decade (1600/1601/1602 are all
  // Flamek Thunder charge levels) and stamps computed causes as base+count
  // (Fraux stores stance stacks as 20000+n), so a miss retries the decade
  // base. Only the decade: a hundreds-floor crosses into different actions
  // (1110 is not a variant of 1100), which is where names become fabrications.
  const decade = causeId - (causeId % 10);
  return decade !== causeId && decade > 0 ? probe(decade) : "";
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

/// The single-string form of `humanizeNumbers`, for the callers that render the
/// figure as text rather than styling the number and its suffix apart.
export const humanizeNumber = (n: number): string => humanizeNumbers(n).join("");

/// Share of `total` to one decimal, or "0.0%" when there is no total to divide
/// by. Distinct from `percent` in `metrics/buffs.ts`, which clamps and rounds
/// differently on purpose — this is the plain contribution-of-total form.
export const share = (value: number, total: number): string =>
  total === 0 ? "0.0%" : `${((value / total) * 100).toFixed(1)}%`;

/// `amount` spread evenly over `windowMs` as a per-second rate, humanized —
/// every rate column the frontend works out for itself: DTPS throughout
/// `damageTaken` (both sides of the hostility toggle), and the rate on
/// `damageDone`'s ENEMY side. Damage Done's friendly rows are not among them;
/// those print the backend's own precomputed `dps`. No window, or one of zero
/// length, means no honest rate rather than a division by zero — and every
/// caller's figures can come from a scrubbed reparse, so the denominator must
/// be the window's own length, not the whole fight's.
export const ratePerSecond = (amount: number, windowMs?: number): string =>
  !windowMs || windowMs <= 0 ? "—" : humanizeNumber(amount / (windowMs / 1000));

/// Takes a number of milliseconds and returns a string in the format of MM:SS.
export const millisecondsToElapsedFormat = (ms: number): string => {
  const date = new Date(Date.UTC(0, 0, 0, 0, 0, 0, ms));
  return `${date.getUTCMinutes().toString().padStart(2, "0")}:${date.getUTCSeconds().toString().padStart(2, "0")}`;
};

/**
 * `MM:SS.mmm` — the events table's timestamp, where several hundred events can
 * share one second and the sub-second order is the whole point.
 *
 * A sibling of `millisecondsToElapsedFormat` rather than a widening of it: that
 * one is the meter's duration readout, which must keep rendering `MM:SS`.
 *
 * Arithmetic, not `Date`: `Date.UTC` wraps the minutes field at 60, so a
 * 90-minute Conflux run would read as `30:00`.
 */
export const millisecondsToPreciseElapsedFormat = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

/**
 * The shortest in-game quest time worth believing, in seconds.
 *
 * Logs recorded before the quest timer was read from the right offset stored a
 * constant 1s — the old read landed on an unrelated field — and 1s renders as a
 * perfectly plausible-looking 00:01. Nothing the game can report is that short:
 * across a real logs.db the bogus rows sit at 0 and 1 while the smallest genuine
 * clear time is 92s.
 */
const MIN_QUEST_ELAPSED_SECS = 2;

/// Whether a stored quest timer is a clear time the game actually reported.
export const hasQuestElapsedTime = (seconds: number | null | undefined): seconds is number =>
  seconds !== null && seconds !== undefined && seconds >= MIN_QUEST_ELAPSED_SECS;

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
///
/// An ARRAY of keys, not a key and a default: `t(key, "ui:characters.X")` makes
/// that string i18next's default VALUE, so a body the generated bundle does not
/// name — Id's dragon form (Pl2000), which is not a playable character —
/// rendered the key itself at the user rather than the name ui.json holds for it.
export const translateCharacterType = (characterType: CharacterType): string =>
  t([`characters:${characterType}`, `ui:characters.${characterType}`]);

/// Builds the `Name (CharacterType)` label shared by the meter and the equipment tab.
///
/// AI companions have their `displayName` blanked by the hook (their identity
/// snapshot carries the LOCAL player's name, which isn't theirs), so an empty name
/// on a resolved slot means "AI" — rendered as `AI (CharacterType)`, i.e. the marker
/// stands in for the missing name so the label keeps its usual shape. Real players
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
    return `${t("ui:characters.ai")} (${type})`;
  }

  return showName ? `${displayName} (${type})` : type;
};

/** Prefer the v2.0.2 record-stat recovery, while retaining the legacy field
 * for logs recorded before that block was available. */
export const getPlayerLevel = (player: PlayerData): number => player.stats?.level || player.playerStats?.level || 1;

/** The tokens a player-name template may use. Exported so the settings editor
 * can list them and flag anything else as a typo. */
export const PLAYER_LABEL_TOKENS = ["slot", "name", "character", "icon"] as const;

/** The subset of PLAYER_LABEL_TOKENS that draws as a node rather than text.
 * Text-only consumers (the tooltip, log exports) blank these instead. */
export const PLAYER_NODE_TOKENS = ["icon"] as const;

/**
 * Token values for one meter row.
 *
 * `name` is empty when there is nothing nameable to show — an unresolved slot,
 * or a real player whose name the user has hidden. Empty is meaningful here: it
 * is what triggers the template engine's collapse rules, so `{name}
 * ({character})` loses its parentheses rather than rendering them around
 * nothing. An AI companion is NOT empty — it resolves to the "AI" marker,
 * because the label still has something to say about that slot.
 */
export const playerLabelTokens = (
  partySlotIndex: number,
  partySlotData: PlayerData | null,
  player: ComputedPlayerState,
  showDisplayNames: boolean
): Record<string, string> => {
  let name = "";
  if (partySlotData) {
    if (partySlotData.displayName === "") {
      name = t("ui:characters.ai");
    } else if (showDisplayNames) {
      name = partySlotData.displayName;
    }
  }

  return {
    slot: partySlotData ? String(partySlotIndex + 1) : "Guest",
    name,
    character: translateCharacterType(player.characterType),
    // The character id doubles as the icon's filename. An unidentified
    // character has no id and so no icon: empty rather than absent, because an
    // absent token renders LITERALLY as `{icon}` — a token that cannot resolve
    // must collapse like any other empty value, not print itself into the meter.
    icon: typeof player.characterType === "string" ? player.characterType : "",
  };
};

/// Formats the player name and translates the player's character type, arranged
/// by the user's own label template (see src/labelTemplate.ts). Callers that
/// have no access to the store omit `template` and get the shipped default,
/// which renders exactly what this function rendered before it was templated.
export const translatedPlayerName = (
  partySlotIndex: number,
  partySlotData: PlayerData | null,
  player?: ComputedPlayerState,
  show_display_names: boolean = true,
  template: string = DEFAULT_PLAYER_LABEL
) => {
  if (!player) return "Guest";

  // The icon has no text form, so it empties here and collapses like any other
  // absent value. Substituting it would print the raw id ("Pl1400 Scott") into
  // the tooltip and everywhere else a label is needed as a plain string.
  return renderTemplate(template, {
    ...playerLabelTokens(partySlotIndex, partySlotData, player, show_display_names),
    icon: "",
  });
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

/// The encounter summary row shared by both clipboard exports.
const encounterSummaryCsv = (encounterState: EncounterState): string => {
  const header = "Encounter Time, Total Damage, Total DPS";
  const values = [
    millisecondsToElapsedFormat(encounterState.endTime - encounterState.startTime),
    encounterState.totalDamage,
    Math.round(encounterState.dps),
  ].join(", ");

  return [header, values].join("\n");
};

/// The header both exports print above a player line.
const PLAYER_CSV_HEADER = "Name, DMG, DPS, %";

/// The party as both exports rank it: party order, each row carrying its share
/// of the encounter's damage, then sorted the way the meter is sorted.
const encounterCsvPlayers = (
  encounterState: EncounterState,
  sortType: SortType,
  sortDirection: SortDirection
): ComputedPlayerState[] => {
  const players: ComputedPlayerState[] = formatInPartyOrder(encounterState.party).map((player) => ({
    ...player,
    percentage: (player.totalDamage / encounterState.totalDamage) * 100,
  }));

  sortPlayers(players, sortType, sortDirection);

  return players;
};

/// One player's row: name, damage, DPS, share of the encounter.
const playerCsvRow = (player: ComputedPlayerState, partyData: Array<PlayerData | null>): string => {
  const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);

  return [
    translatedPlayerName(partySlotIndex, partyData[partySlotIndex], player),
    player.totalDamage,
    Math.round(player.dps),
    `${player.percentage?.toFixed(2)}%`,
  ].join(", ");
};

/// A player's skill table for the detailed export: biggest hitter first, each
/// row carrying its share of that player's own damage.
const skillCsvRows = (player: ComputedPlayerState): string => {
  // Folded for the same reason the table folds: every echo payload exports the
  // one name "Supplementary Damage", so unfolded the export repeats that line
  // once per causing skill with the damage split between the copies.
  const breakdown = mergeSupplementaryRows(player.skillBreakdown);
  const totalDamage = breakdown.reduce((acc, skill) => acc + skill.totalDamage, 0);

  return breakdown
    .map((skill) => ({
      // Guard the denominator: a guard-only player (all zero-damage Perfect
      // Guard rows) has totalDamage 0, which would export "NaN%" for every
      // row — same guard as useSkillBreakdown.
      percentage: totalDamage > 0 ? (skill.totalDamage / totalDamage) * 100 : 0,
      ...skill,
    }))
    .sort((a, b) => b.totalDamage - a.totalDamage)
    .map((skill) =>
      [
        getSkillName(player.characterType, skill),
        skill.hits,
        skill.totalDamage,
        skill.minDamage,
        skill.maxDamage,
        Math.round(skill.hits === 0 ? 0 : skill.totalDamage / skill.hits),
        `${skill.percentage.toFixed(2)}%`,
      ].join(", ")
    )
    .join("\n");
};

/// Puts an assembled export on the clipboard and says so.
const copyEncounterCsv = (sections: string[]) => {
  navigator.clipboard.writeText(sections.join("\n")).then(() => {
    toast.success(t("ui.copied-to-clipboard"));
  });
};

/// Exports the encounter data to the clipboard in a simple format (CSV)
export const exportSimpleEncounterToClipboard = (
  sortType: SortType,
  sortDirection: SortDirection,
  encounterState: EncounterState,
  partyData: Array<PlayerData | null>
) => {
  if (encounterState.totalDamage === 0) return toast.error("Nothing to copy!");

  const players = encounterCsvPlayers(encounterState, sortType, sortDirection);

  copyEncounterCsv([
    encounterSummaryCsv(encounterState),
    PLAYER_CSV_HEADER,
    players.map((player) => playerCsvRow(player, partyData)).join("\n"),
  ]);
};

/// Exports the encounter data to the clipboard in a detailed format (CSV)
///
/// The simple export's rows, each followed by that player's own skill table —
/// so the two share everything above the skill block rather than keeping a
/// second copy of it.
export const exportFullEncounterToClipboard = (
  sortType: SortType,
  sortDirection: SortDirection,
  encounterState: EncounterState,
  partyData: Array<PlayerData | null>
) => {
  if (encounterState.totalDamage === 0) return toast.error("Nothing to copy!");

  const skillHeader = ["Skill", "Hits", "Total", "Min", "Max", "Avg", "%"].join(", ");
  const players = encounterCsvPlayers(encounterState, sortType, sortDirection);

  copyEncounterCsv([
    encounterSummaryCsv(encounterState),
    players
      .map((player) =>
        [PLAYER_CSV_HEADER, playerCsvRow(player, partyData), skillHeader, skillCsvRows(player)].join("\n")
      )
      .join("\n"),
  ]);
};

export const PLAYER_COLORS = ["#FF5630", "#FFAB00", "#36B37E", "#00B8D9", "#9BCF53", "#380E7F", "#416D19", "#2C568D"];

/// The categorical palette for ENEMY actors, the counterpart to PLAYER_COLORS.
///
/// A separate list rather than a shared one, and deliberately in hues the four
/// player DEFAULTS do not occupy (red-orange, amber, green, cyan): the point of
/// colouring an actor at all is telling friendly from hostile at a glance, and
/// a boss drawn in the same green as your healer defeats it. Non-collision can
/// only ever be a default — the first four player colours are user-settable, so
/// someone who sets one to magenta will collide, and that is their choice.
///
/// Indexed by SPAWN, not by actor index: the game reissues a dead boss's actor
/// index to the next one, so two waves would otherwise share a colour while the
/// rows insist they are different enemies.
///
/// The list only; `pages/logs/view/actorColor.ts` is what resolves an actor to
/// one of these, and is the single entry point the chart, the table, the pin
/// selectors and the events stream all go through.
export const ENEMY_COLORS = ["#F06595", "#CC5DE8", "#845EF7", "#5C7CFA", "#A9B1BD", "#D6336C", "#9775FA", "#4DABF7"];

/// The categorical palette for compared LOGS — one colour per pane, worn by that
/// log's line on the compare overlay, the rule where its run ended, its selector
/// in the actor bar and its column's title (see `paneSeriesColor`).
///
/// A third list rather than reusing PLAYER_COLORS, for two reasons:
///
/// * Nothing here is red, orange or amber. A whole column tinted in one of those
///   reads as an error or a warning about that log, which is what every other
///   red/amber mark in this app means (the imported badge, a failed fetch, the
///   legality findings). A log is not in a bad state for being compared.
/// * A pane colour and a party colour appear TOGETHER in the split layout — the
///   end rules wear this palette while the bands under them wear the party's —
///   so drawing both from one list would put a log and a player in one colour.
///
/// The first two are what a two-log comparison actually uses, and they are a
/// blue and a magenta on purpose: that pair keeps its separation under deutan
/// and protan simulation, where blue-against-green or blue-against-violet does
/// not. Green is deliberately absent as well — in this app it means "cleared".
export const COMPARE_COLORS = ["#4DABF7", "#DA77F2", "#22B8CF", "#748FFC", "#E599F7", "#66D9E8", "#B197FC", "#A9B1BD"];

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
/// The width a row's bar should be painted at, as a percentage.
///
/// In `relative` mode the largest row in a table fills its bar and every other
/// row is scaled against it, which makes the differences between the middle
/// rows readable. It changes the painted width ONLY — the percentage in the
/// column stays a true share of the total, because that one is data.
///
/// A zero `maxPercentage` (nothing has dealt damage yet) falls through to the
/// raw percentage rather than dividing by zero.
export const barWidth = (percentage: number, maxPercentage: number, mode: BarFillMode): number =>
  mode === "relative" && maxPercentage > 0 ? (percentage / maxPercentage) * 100 : percentage;

/// The meter's grid track template, for a table with `columnCount` value
/// columns.
///
/// Built here rather than at each table because the header row, the player rows
/// and the skill rows all read `--meter-grid`, and their lining up is the whole
/// point of the shared template — two components composing it separately is two
/// chances for the header to stop matching the rows under it.
///
/// It cannot move into App.css: `repeat()` needs a literal integer count, so a
/// `var()` there does not parse.
///
/// Zero columns drops the `repeat()` entirely rather than emitting `repeat(0,
/// …)`, which `repeat()`'s `<integer [1,∞]>` grammar rejects — and an invalid
/// `var()` substitution takes the WHOLE declaration with it, so the name track
/// would be lost too and the header would stop lining up with its rows. The
/// user can reach zero: nothing stops them unchecking every value column.
export const meterGridTemplate = (columnCount: number): string =>
  columnCount > 0 ? `minmax(120px, 1fr) repeat(${columnCount}, var(--meter-value-col))` : "minmax(120px, 1fr)";

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

/** The game's own name for a status effect, or `""` where it has none.
 *
 * Keyed by `status.tbl`'s decimal `StatusId` — the value the hook puts in
 * `StatusApplyEvent.status_id` — rather than by a hash like every other bundle,
 * because statuses are the one table the runtime identifies by row id.
 *
 * Empty rather than a placeholder on a miss: the bundle names 156 of the 168
 * rows; the rest are internal (`nayde1`, `mspl1900_01`) with no text at all.
 * `statusLabelFor` reads empty as "unnamed" and falls back to "Effect <id>",
 * which is the documented shipping path. */
export const translateStatusName = (statusId: number): string => t(`statuses:${statusId}.text`, { defaultValue: "" });

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

/** A summed optional field, ABSENT when no row carried it — a legacy payload's
 * missing field must not become a 0 the table reads as a real measurement. */
const sumOptional = <T>(rows: T[], value: (row: T) => number | undefined): number | undefined =>
  rows.some((row) => value(row) !== undefined) ? rows.reduce((total, row) => total + (value(row) ?? 0), 0) : undefined;

/** The smallest (or largest) figure any row recorded, or null when none did —
 * logs saved before `minDamage`/`maxDamage` existed carry null, and folding that
 * in as a 0 would claim a hit landed for nothing. */
const recordedExtreme = (values: (number | null)[], pick: (a: number, b: number) => number): number | null => {
  const known = values.filter((value): value is number => value !== null);
  // `reduce(Math.min)` would hand the index and the array to Math.min as extra
  // arguments and answer NaN, so the fold is spelled out.
  return known.length === 0 ? null : known.reduce((chosen, value) => pick(chosen, value));
};

/** Every supplementary-damage (echo) row folded into ONE, in the first echo's
 * place; anything else passes through untouched.
 *
 * The parser emits one breakdown row per `SupplementaryDamage(n)` payload
 * because `n` names the skill that CAUSED the echo — the attribution the
 * analysis view's collapse toggle reads (`rowKeyingFor`). Nothing else can use
 * it: `getSkillName` names every payload "Supplementary Damage" and
 * `skillGroupFor` leaves echoes ungrouped, so a surface with no cause
 * attribution of its own repeats that one name once per cause unless it folds
 * here. This is the fold the parser used to do for everyone.
 *
 * NOT the skill-group condense, and deliberately not gated on it: an echo
 * belongs to no group, and its row was single whatever that setting said.
 *
 * Folded onto the first echo so the row keeps a real payload and its position in
 * the breakdown, exactly as the parser's own fold did. */
export const mergeSupplementaryRows = <T extends SkillState>(rows: T[]): T[] => {
  const echoes = rows.filter((row) => isSupplementaryAction(row.actionType));
  if (echoes.length < 2) return rows;

  const folded: T = {
    ...echoes[0],
    hits: echoes.reduce((total, row) => total + row.hits, 0),
    totalDamage: echoes.reduce((total, row) => total + row.totalDamage, 0),
    minDamage: recordedExtreme(
      echoes.map((row) => row.minDamage),
      Math.min
    ),
    maxDamage: recordedExtreme(
      echoes.map((row) => row.maxDamage),
      Math.max
    ),
    totalStunValue: echoes.reduce((total, row) => total + row.totalStunValue, 0),
    maxStunValue: echoes.reduce((max, row) => Math.max(max, row.maxStunValue), 0),
    cappedHits: echoes.reduce((total, row) => total + row.cappedHits, 0),
    cappableHits: echoes.reduce((total, row) => total + row.cappableHits, 0),
    overcapBaseSum: echoes.reduce((total, row) => total + row.overcapBaseSum, 0),
    overcapCapSum: echoes.reduce((total, row) => total + row.overcapCapSum, 0),
    sbaGenerated: sumOptional(echoes, (row) => row.sbaGenerated),
    stunDeltaSum: sumOptional(echoes, (row) => row.stunDeltaSum),
    stunMessageSum: sumOptional(echoes, (row) => row.stunMessageSum),
    stunEligibleHits: sumOptional(echoes, (row) => row.stunEligibleHits),
    targets: echoes.some((row) => row.targets !== undefined)
      ? mergeTargetBreakdowns(echoes.map((row) => row.targets))
      : undefined,
  };

  let placed = false;
  return rows.flatMap((row) => {
    if (!isSupplementaryAction(row.actionType)) return [row];
    if (placed) return [];
    placed = true;
    return [folded];
  });
};

/** The quest a training-dummy run is filed under. Mirrors
 * `parser::constants::TRAINING_DUMMY_QUEST_ID`, which is what the backend puts
 * on every log whose enemy is Sir Barrold — training is not a quest and carries
 * no id of its own.
 *
 * Named here rather than in the `quests` bundle because that bundle is
 * generated from the game's own quest table, and this id is the app's. */
export const TRAINING_DUMMY_QUEST_ID = 0xa379ac65;

/// Translates the quest ID to a human-readable string.
export const translateQuestId = (id: number | null): string => {
  if (id === null) return "";
  // `ui.logs.…`, not `logs.…`: the `ui` NAMESPACE is the whole of `ui.json`,
  // whose root holds a `ui` object beside `quest`/`characters`/… — so the app's
  // own strings are two segments deep and a key that drops the first renders as
  // itself. (`quest.unknown` below is a root sibling, which is why it does not.)
  if (id === TRAINING_DUMMY_QUEST_ID) return t("ui.logs.quest-training-dummy");
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

/** One hashed table-key id, named through its bundle.
 *
 * Eight id spaces — traits, abilities, sigils, items, overmasteries, weapons,
 * summons and summon equip-bonuses — are keyed identically: the game's 32-bit
 * table-key hash, written as eight lowercase hex digits, naming a
 * `<namespace>:<hash>.text` bundle entry. The namespace is the only thing that
 * varies between them, so it is the only thing the wrappers below pass.
 *
 * The padding is load-bearing, not cosmetic: the generated bundles spell every
 * key as eight digits, so a hash with a leading zero misses its own entry
 * without it.
 *
 * Both guards answer "" rather than the unknown label. `null` means the log
 * never recorded one and EMPTY_ID is the game's own "this slot is empty" —
 * neither is an id we tried and failed to name, and rendering
 * "Unknown (887b8bb0)" for an empty slot reads as a parser bug.
 */
const translateHashedId = (namespace: string, id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`${namespace}:${hash}.text`, "ui.unknown-id"], { id: hash });
};

/// Translates the trait ID to a human-readable string.
export const translateTraitId = (id: number | null): string => translateHashedId("traits", id);

/// Translates the ability (equipped skill) ID to a human-readable string.
export const translateAbilityId = (id: number | null): string => translateHashedId("abilities", id);

/// Translates the sigil ID to a human-readable string.
export const translateSigilId = (id: number | null): string => translateHashedId("sigils", id);

/// Translates the item ID to a human-readable string.
export const translateItemId = (id: number | null): string => translateHashedId("items", id);

/** The wrightstone's display name. The stone's ITEM id never syncs for remote
 * players (only its trait pairs do), so 0 means "a stone we can't name", not
 * "Unknown (00000000)" — fall back to the generic label. */
export const translateWrightstoneId = (id: number | null): string =>
  id && id !== EMPTY_ID ? translateItemId(id) : t("ui.wrightstone");

/// Translates the overmastery ID to a human-readable string.
export const translateOvermasteryId = (id: number | null): string => translateHashedId("overmasteries", id);

/// Translates a numeric weapon ID (weapon table key hash) to a human-readable string.
export const translateWeaponId = (id: number | null): string => translateHashedId("weapons", id);

/// Translates the summon ID (summon table key) to a human-readable string.
export const translateSummonId = (id: number | null): string => translateHashedId("summons", id);

/// Translates the summon equip-bonus ID (summon base-param key) to a human-readable string.
export const translateSummonBonusId = (id: number | null): string => translateHashedId("summon-bonuses", id);

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

/** Narrows a tab name carried in the URL to one the page can actually show.
 * Tabs come back from the query string, which outlives the data behind them —
 * a log with no player data disables its equipment/builds tabs, and selecting a
 * disabled tab would leave the page with no panel rendered at all. */
export const resolveAvailableTab = <T extends string>(tab: string | null, available: readonly T[], fallback: T): T =>
  available.includes(tab as T) ? (tab as T) : fallback;

/** `set` with `member` flipped in or out, as a NEW set — the shape a set held as
 * React state is updated in. One author, because a set-as-state that is mutated
 * in place instead of replaced does not re-render, and that mistake reads as
 * "the click did nothing" rather than as a bug. */
export const toggled = <T>(set: ReadonlySet<T>, member: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
};

/// Hook that returns the previous value of a variable.
export const usePrevious = <T>(value: T): T | undefined => {
  const ref = useRef<T>();

  useEffect(() => {
    ref.current = value;
  });

  return ref.current;
};

export const registerShortcutBlocker = (): (() => void) => {
  const handleKeyDown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && ["j", "p", "u"].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  window.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
};
