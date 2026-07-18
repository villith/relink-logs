import { open } from "@tauri-apps/api/shell";
import html2canvas from "html2canvas";
import * as jsurl from "jsurl";
import toast from "react-hot-toast";
import {
  CharacterType,
  ComputedPlayerState,
  EncounterState,
  EnemyType,
  MeterColumns,
  PlayerData,
  PlayerState,
  SkillState,
  SortDirection,
  SortType,
} from "./types";

import i18next, { t } from "i18next";
import { useEffect, useRef } from "react";

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

export const getSkillName = (characterType: CharacterType, skill: SkillState) => {
  switch (true) {
    case skill.actionType === "LinkAttack":
      return t([`skills.${characterType}.link-attack`, "skills.default.link-attack"]);
    case skill.actionType === "SBA":
      return t([`skills.${characterType}.skybound-arts`, "skills.default.skybound-arts"]);
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "SupplementaryDamage"):
      return t(["skills.default.supplementary-damage"]);
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "DamageOverTime"):
      return t([
        `skills.${skill.childCharacterType}.damage-over-time`,
        `skills.${characterType}.damage-over-time`,
        "skills.default.damage-over-time",
      ]);
    case typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "Normal"): {
      const actionType = skill.actionType as { Normal: number };
      const skillID = actionType["Normal"];

      return t(
        [
          `skills.${skill.childCharacterType}.${skillID}`,
          `skills.${characterType}.${skillID}`,
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
  if (n >= 1e3 && n < 1e6) return [+(n / 1e3).toFixed(1), "k"];
  if (n >= 1e6 && n < 1e9) return [+(n / 1e6).toFixed(1), "m"];
  if (n >= 1e9 && n < 1e12) return [+(n / 1e9).toFixed(1), "b"];
  if (n >= 1e12) return [+(n / 1e12).toFixed(1), "t"];
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
          percentage: (skill.totalDamage / totalDamage) * 100,
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
          percentage: (skill.totalDamage / totalDamage) * 100,
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

/// Translates the quest ID to a human-readable string.
export const translateQuestId = (id: number | null): string => {
  if (id === null) return "";
  const hash = id.toString(16);
  return t([`quests:${hash}.text`, "quest.unknown"], { id: hash });
};

/// Translates the trait ID to a human-readable string.
export const translateTraitId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`traits:${hash}.text`, "ui.unknown"], { id: hash });
};

/// Translates the sigil ID to a human-readable string.
export const translateSigilId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`sigils:${hash}.text`, "ui.unknown"], { id: hash });
};

/// Translates the item ID to a human-readable string.
export const translateItemId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`items:${hash}.text`, "ui.unknown"], { id: hash });
};

/// Translates the overmastery ID to a human-readable string.
export const translateOvermasteryId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");

  return t([`overmasteries:${hash}.text`, "ui.unknown"], { id: hash });
};

/// Translates the summon ID (summon table key) to a human-readable string.
export const translateSummonId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`summons:${hash}.text`, "ui.unknown"], { id: hash });
};

/// Translates the summon equip-bonus ID (summon base-param key) to a human-readable string.
export const translateSummonBonusId = (id: number | null): string => {
  if (id === null) return "";
  if (id === EMPTY_ID) return "";

  const hash = id.toString(16).padStart(8, "0");
  return t([`summon-bonuses:${hash}.text`, "ui.unknown"], { id: hash });
};

// Reverse index for translateWeaponKey, rebuilt when the language changes: the
// hook reports the equipped weapon as its game KEY NAME (e.g. "WEP_PL2700_02_01"),
// while the weapons bundle is keyed by hash — but each entry carries its `key`
// name, so a scan over the bundle bridges the two without hashing.
const weaponNameByKey = new Map<string, string>();
let weaponNameByKeyLang: string | null = null;

/// Translates a weapon key name (e.g. "WEP_PL2700_02_01") to a human-readable
/// string, falling back to the raw key when no translation exists.
export const translateWeaponKey = (key: string): string => {
  if (!key) return "";
  const lang = i18next.language || "en";
  if (weaponNameByKeyLang !== lang) {
    weaponNameByKey.clear();
    weaponNameByKeyLang = lang;
    // Active language first; en fills the gaps (matches i18next fallback).
    for (const bundle of [i18next.getResourceBundle(lang, "weapons"), i18next.getResourceBundle("en", "weapons")]) {
      if (!bundle) continue;
      for (const entry of Object.values(bundle) as Array<{ key?: string; text?: string }>) {
        if (entry?.key && entry?.text && !weaponNameByKey.has(entry.key)) {
          weaponNameByKey.set(entry.key, entry.text);
        }
      }
    }
  }
  return weaponNameByKey.get(key) ?? key;
};

/// Converts a number to a hexadecimal string.
export const toHash = (num: number): string => num.toString(16);

/// Converts a number to a hexadecimal string and pads it to 8 characters.
export const toHashString = (num: number | undefined): string => (num ? num.toString(16).padStart(8, "0") : "");

/// Hook that returns the previous value of a variable.
export const usePrevious = <T>(value: T): T | undefined => {
  const ref = useRef<T>();

  useEffect(() => {
    ref.current = value;
  });

  return ref.current;
};
