import type { EncounterState, PlayerData, PlayerState } from "@/types";

/**
 * A fake four-player encounter for the settings preview.
 *
 * Shares are spread wide on purpose (42 / 31 / 19 / 8): a preview whose bars
 * are all similar lengths cannot show the difference between the two fill
 * modes, which is the setting it exists to explain.
 */
const SHARES = [
  { index: 0, characterType: "Pl1000", displayName: "Player", damage: 4_210_000 },
  { index: 1, characterType: "Pl1400", displayName: "Ally", damage: 3_140_000 },
  { index: 2, characterType: "Pl1800", displayName: "", damage: 1_890_000 },
  { index: 3, characterType: "Pl2100", displayName: "Guest", damage: 760_000 },
] as const;

const TOTAL_DAMAGE = SHARES.reduce((sum, share) => sum + share.damage, 0);

/** Duration the preview pretends the fight ran for, in ms. */
const DURATION_MS = 161_000;

const makePlayer = (share: (typeof SHARES)[number]): PlayerState => ({
  index: share.index,
  characterType: share.characterType,
  totalDamage: share.damage,
  dps: Math.round(share.damage / (DURATION_MS / 1000)),
  sba: 0,
  totalStunValue: 0,
  stunPerSecond: 0,
  lastDamageTime: DURATION_MS,
  // Empty: the preview never expands a row, so no breakdown is needed and an
  // empty one keeps the fixture honest about what it is.
  skillBreakdown: [],
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
});

const makePartyMember = (share: (typeof SHARES)[number]): PlayerData => ({
  actorIndex: share.index,
  displayName: share.displayName,
  characterName: share.displayName,
  characterType: share.characterType,
  sigils: [],
  summons: [],
  abilities: [],
  weaponKey: "",
  masterLevel: 0,
  skillboard: [],
  stats: null,
  weaponState: null,
  limitBonusCapNormal: null,
  limitBonusCapSkill: null,
  limitBonusCapSba: null,
  isOnline: false,
  weaponInfo: null,
  overmasteryInfo: null,
  playerStats: null,
});

export const PREVIEW_ENCOUNTER: EncounterState = {
  totalDamage: TOTAL_DAMAGE,
  dps: Math.round(TOTAL_DAMAGE / (DURATION_MS / 1000)),
  startTime: 0,
  endTime: DURATION_MS,
  party: Object.fromEntries(SHARES.map((share) => [String(share.index), makePlayer(share)])),
  status: "Stopped",
  targets: {},
};

export const PREVIEW_PARTY: Array<PlayerData | null> = SHARES.map(makePartyMember);

/** Header token values matching the fixture encounter — a boss fight in
 * progress, so every token has something to show. */
export const PREVIEW_HEADER_TOKENS = {
  app: "Relink Logs",
  version: "1.0.0",
  damage: "9.8m",
  dps: "61.2k",
  hpPercent: "45.2%",
  hpCurrent: "1.2b",
  hpMax: "2.6b",
  time: "02:41",
  status: "02:41",
};
