/**
 * CharacterType represents the type of character that a player can be.
 *
 * Examples:
 * - `"Pl1000"`
 * - `"Pl1800"`
 * - `{ Unknown: 0xF546E414 }`
 */
export type CharacterType = string | { Unknown: number };

/**
 * EnemyType represents the type of enemy.
 *
 * Examples:
 * - `"Em1000"`
 * - `"Em1200"`
 * - `{ Unknown: 0xF546E414 }`
 */
export type EnemyType = string | { Unknown: number };

/**
 * ActionType represents the type of action that a skill can be.
 *
 * Examples:
 * - `"LinkAttack"` - Link Attack
 * - `"SBA"` - Skybound Art
 * - `{ SupplementaryDamage: 113 }` (as its key, object with a number representing the skill number)
 * - `{ Normal: 113 }` (as its key, object with a number representing the skill number)
 */
export type ActionType =
  | "LinkAttack"
  | "SBA"
  | { SupplementaryDamage: number }
  | { DamageOverTime: number }
  | { Normal: number }
  | { Group: string };

export type SkillState = {
  /** ActionType of the skill */
  actionType: ActionType;
  /** For some characters, the skill can be a child of another character type. */
  childCharacterType: CharacterType;
  /** Number of total hits of the skill */
  hits: number;
  /** Minimum damage of the skill */
  minDamage: number | null;
  /** Maximum damage of the skill */
  maxDamage: number | null;
  /** Total damage of the skill */
  totalDamage: number;
  /** Total stun value of the skill hits */
  totalStunValue: number;
  /** Maximum recorded stun value of the skill */
  maxStunValue: number;
  /** Number of hits that reached the game's damage cap */
  cappedHits: number;
  /** Number of hits that were subject to a damage cap at all (cap-less sources like supplementary damage excluded) */
  cappableHits: number;
  /** Sum of pre-cap base damage over cappable hits (for overcap %: baseSum/capSum*100) */
  overcapBaseSum: number;
  /** Sum of damage caps over cappable hits */
  overcapCapSum: number;
};

export type ComputedSkillState = SkillState & {
  /** Damage contribution as a percentage of the total */
  percentage: number;
};

export type ComputedSkillGroup = {
  /** ActionType of the skill */
  actionType: ActionType;
  /** For some characters, the skill can be a child of another character type. */
  childCharacterType: CharacterType;
  /** Number of total hits of the skill */
  hits: number;
  /** Minimum damage of the skill */
  minDamage: number | null;
  /** Maximum damage of the skill */
  maxDamage: number | null;
  /** Total damage of the skill */
  totalDamage: number;
  /** Damage contribution as a percentage of the total */
  percentage: number;
  /** Skills */
  skills?: ComputedSkillState[];
  /** Total stun value of the skill hits */
  totalStunValue: number;
  /** Maximum recorded stun value of the skill */
  maxStunValue: number;
  /** Number of hits that reached the game's damage cap (summed over grouped skills) */
  cappedHits: number;
  /** Number of cappable hits (summed over grouped skills) */
  cappableHits: number;
  /** Sum of pre-cap base damage over cappable hits (summed over grouped skills) */
  overcapBaseSum: number;
  /** Sum of damage caps over cappable hits (summed over grouped skills) */
  overcapCapSum: number;
};

export type PlayerState = {
  /** Unique ID for this player */
  index: number;
  /** Character type of this player. (Pl1000 / Pl1800 / ..) */
  characterType: CharacterType;
  /** Total damage dealt */
  totalDamage: number;
  /** DPS over the encounter time */
  dps: number;
  /** Amount of SBA Gauge (0.0 - 1000.0) */
  sba: number;
  /** Total stun value */
  totalStunValue: number;
  /** Stun per second over the encounter time */
  stunPerSecond: number;
  /** Stun captured via accumulator deltas (solo path; 0 in online lobbies) */
  stunDeltaSum?: number;
  /** Stun captured via network stun messages (online path); totalStunValue = max of both */
  stunMessageSum?: number;
  /** Time of the last damage dealt */
  lastDamageTime: number;
  /** Stats for individual skills logged */
  skillBreakdown: SkillState[];
  /** Number of hits by this player that reached the game's damage cap */
  cappedHits: number;
  /** Number of hits by this player that were subject to a damage cap at all */
  cappableHits: number;
  /** Sum of pre-cap base damage over cappable hits (for overcap %: baseSum/capSum*100) */
  overcapBaseSum: number;
  /** Sum of damage caps over cappable hits */
  overcapCapSum: number;
};

export type ComputedPlayerState = PlayerState & {
  /** Damage contribution as a percentage of the total */
  percentage: number;
  /** Actual party index */
  partyIndex: number;
};

export type EnemyState = {
  /** Enemy index */
  index: number;
  /** Enemy type */
  targetType: EnemyType;
  /** Total damage done to this target */
  totalDamage: number;
};

export type EncounterStatus = "Waiting" | "InProgress" | "Stopped";

export type EncounterState = {
  /** Total damage dealt in the whole encounter */
  totalDamage: number;
  /** Total DPS dealt over the encounter time */
  dps: number;
  /** Encounter-wide stun via accumulator deltas (solo path; 0 online) */
  stunDeltaSum?: number;
  /** Encounter-wide stun via network stun messages (online path); the served totals are max of both */
  stunMessageSum?: number;
  /** The time of the encounter's first damage instance (UTC milliseconds since epoch) */
  startTime: number;
  /** The time of the encounter's last known damage instance (UTC milliseconds since epoch) */
  endTime: number;
  /** Represents the players in the encounter */
  party: Record<string, PlayerState>;
  /** Status of the encounter */
  status: EncounterStatus;
  /** Targets for this encounter */
  targets: Record<number, EnemyState>;
};

export type EncounterUpdateEvent = {
  event: string;
  payload: EncounterState;
};

export type EncounterResetEvent = {
  event: string;
  payload: EncounterState;
};

export type Sigil = {
  firstTraitId: number;
  firstTraitLevel: number;
  secondTraitId: number;
  secondTraitLevel: number;
  sigilId: number;
  equippedCharacter: number;
  sigilLevel: number;
  acquisitionCount: number;
  notificationEnum: number;
};

export type WeaponInfo = {
  weaponId: number;
  starLevel: number;
  plusMarks: number;
  awakeningLevel: number;
  trait1Id: number;
  trait1Level: number;
  trait2Id: number;
  trait2Level: number;
  trait3Id: number;
  trait3Level: number;
  wrightstoneId: number;
  weaponLevel: number;
  weaponHp: number;
  weaponAttack: number;
};

export type Overmastery = {
  id: number;
  flags: number;
  value: number;
};

/** The v2.0.2 record-inline stat block. Labels for hp/attack/stunPower/power
 * follow the pre-2.0 PlayerStats layout the block mirrors; unk50/unk58 are
 * still-unconfirmed slots. */
export type RecordStats = {
  level: number;
  hp: number;
  attack: number;
  unk50: number;
  stunPower: number;
  unk58: number;
  power: number;
};

/** One trait id/level pair (wrightstone or innate weapon skill); level 0 =
 * not yet known. */
export type WeaponTraitPair = {
  id: number;
  level: number;
};

/** The equipped weapon's state (live-labeled). weaponId is the weapon.tbl Key
 * hash of the equipped (transcendence-variant) row — the `weapons:` bundle's
 * map key. innateTraits are the ACTIVE skills (awakening/transcendence
 * upgrades applied by the game). */
export type WeaponState = {
  weaponId: number;
  exp: number;
  starLevel: number;
  plusMarks: number;
  awakeningLevel: number;
  wrightstoneId: number;
  wrightstoneTraits: WeaponTraitPair[];
  innateTraits: WeaponTraitPair[];
};

export type OvermasteryInfo = {
  overmasteries: Overmastery[];
};

export type PlayerStats = {
  level: number;
  totalHp: number;
  totalAttack: number;
  stunPower: number;
  criticalRate: number;
  totalPower: number;
};

export type EquippedSummon = {
  summonId: number;
  mainTraitId: number;
  mainTraitLevel: number;
  bonusId: number;
  bonusLevel: number;
};

export type PlayerData = {
  actorIndex: number;
  displayName: string;
  characterName: string;
  characterType: CharacterType;
  sigils: Sigil[];
  summons: EquippedSummon[];
  /** The 4 equipped ability (skill) id hashes; empty on logs from older versions. */
  abilities: number[];
  /** Equipped weapon as its game key name (e.g. "WEP_PL2700_02_01"); "" when unknown. */
  weaponKey: string;
  /** Master level, level+stars combined (55 = 50 + 5 stars); 0 when unknown. */
  masterLevel: number;
  /** Unlocked skillboard (master trait) node effect ids; empty on older logs. */
  skillboard: number[];
  /** Record-inline stat block (v2.0.2 identity recovery); null on older logs.
   * `unk50`/`unk58` are still-unlabeled slots (see the Rust-side docs). */
  stats: RecordStats | null;
  /** Equipped weapon save-row snapshot (v2.0.2 identity recovery); null on older logs. */
  weaponState: WeaponState | null;
  isOnline: boolean;
  weaponInfo: WeaponInfo | null;
  overmasteryInfo: OvermasteryInfo | null;
  playerStats: PlayerStats | null;
};

export type PartyUpdateEvent = {
  event: string;
  payload: Array<PlayerData | null>;
};

export enum MeterColumns {
  Name = "name",
  DPS = "dps",
  TotalDamage = "damage",
  SupPercentage = "sup-percentage",
  DamagePercentage = "damage-percentage",
  SBA = "sba",
  TotalStunValue = "total-stun-value",
  StunPerSecond = "stun-per-second",
}

export type SortType = MeterColumns;

export type LogSortType = "time" | "duration" | "quest-elapsed-time";
export type SortDirection = "asc" | "desc";

export type Log = {
  id: number;
  name: string;
  time: number;
  duration: number;
  version: number;
  primaryTarget: EnemyType | null;
  p1Name: string | null;
  p1Type: string | null;
  p2Name: string | null;
  p2Type: string | null;
  p3Name: string | null;
  p3Type: string | null;
  p4Name: string | null;
  p4Type: string | null;
  questId: number | null;
  questElapsedTime: number | null;
  questCompleted: boolean;
};

export type ConfluxBuffDelta = {
  roomIndex: number;
  buffIds: number[];
};

export type ConfluxRoom = {
  logId: number;
  roomIndex: number;
  questId: number | null;
  primaryTarget: number | null;
  duration: number;
  totalDamage: number | null;
};

export type ConfluxRun = {
  id: number;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  roomCount: number;
  completed: boolean | null;
  buffs: ConfluxBuffDelta[];
  rooms: ConfluxRoom[];
};

export type ConfluxSearchResult = {
  runs: ConfluxRun[];
  page: number;
  pageCount: number;
  runCount: number;
};

export type SBAEvent = [
  number,
  (
    | { OnAttemptSBA: { actor_index: number } }
    | { OnPerformSBA: { actor_index: number } }
    | { OnContinueSBAChain: { actor_index: number } }
  ),
];

export type DeathEvent = [number, { OnDeathEvent: { actor_index: number; death_counter: number } }];
