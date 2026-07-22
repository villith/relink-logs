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
 * One selectable target spawn of an encounter (mirrors the Rust
 * `TargetSegment`): one contiguous lifetime of one spawn, 1:1 with the HP
 * chart's series. `instance` is the "#n" shared with the chart; `id` alone is
 * NOT unique across a fight (the game reuses freed instance ids across summon
 * waves), which is why selections are spans.
 */
export type TargetEntry = {
  id: number;
  enemyType: EnemyType;
  instance: number;
  maxHp: number | null;
  startMs: number;
  endMs: number;
};

/** The selectable slice of a TargetEntry, sent back as a filter. */
export type TargetSpan = {
  id: number;
  startMs: number;
  endMs: number;
};

/**
 * One enemy HP pool charted on the quest-details view (mirrors the Rust
 * `HpChartSeries`). `instance` is 1-based among charted pools sharing the same
 * enemy type, for disambiguating duplicate labels; `values` holds post-hit HP%
 * per second, null where the pool wasn't hit.
 */
export type HpChartSeries = {
  enemyType: EnemyType;
  instance: number;
  maxHp: number;
  values: (number | null)[];
};

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
  | "PerfectGuard"
  | "PerfectGuardQuickening"
  | { StunEffect: number }
  | { SupplementaryDamage: number }
  | { DamageOverTime: number }
  | { Normal: number }
  | { Group: string };

/** Per-enemy-type share of one skill's damage (mirrors the Rust
 * `SkillTargetState`); same-type spawns merge into one entry. Computed under
 * the active target/time filters, like the rest of the derived state. */
export type SkillTargetState = {
  enemyType: EnemyType;
  hits: number;
  totalDamage: number;
};

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
  /** Stun captured via per-hit accumulator deltas (solo path; 0 in online lobbies) */
  stunDeltaSum?: number;
  /** Stun captured via network stun messages attributed to this skill (online path); totalStunValue = max of both */
  stunMessageSum?: number;
  /** Hits that actually applied stun (excludes 0-stun/echo/DoT); the denominator for "stun per hit". Optional so older cached payloads stay valid. */
  stunEligibleHits?: number;
  /** Number of hits that reached the game's damage cap */
  cappedHits: number;
  /** Number of hits that were subject to a damage cap at all (cap-less sources like supplementary damage excluded) */
  cappableHits: number;
  /** Sum of pre-cap base damage over cappable hits (for overcap %: baseSum/capSum*100) */
  overcapBaseSum: number;
  /** Sum of damage caps over cappable hits */
  overcapCapSum: number;
  /** Per-enemy damage breakdown (optional so cached/older payloads without it stay valid) */
  targets?: SkillTargetState[];
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
  /** Hits that actually applied stun (summed over grouped skills) */
  stunEligibleHits?: number;
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
  /** Remaining HP after the last hit on this target's largest HP pool.
   * Rust `Option<u64>` with no `skip_serializing_if`, so "no pool" arrives as `null`. */
  currentHp?: number | null;
  /** Maximum HP of that pool; `null` alongside `currentHp`. */
  maxHp?: number | null;
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

/**
 * Customizable value columns in the skill breakdown (live overlay only; the
 * logs detail view always shows the full set). The Skill name column is always
 * shown and is not part of this list. Enum member order is irrelevant — the
 * display order is whatever the user's column list holds.
 */
export enum SkillColumns {
  Hits = "hits",
  TotalDamage = "total",
  MinDamage = "min",
  MaxDamage = "max",
  AverageDamage = "average",
  TotalStunValue = "stun",
  StunEligibleHits = "stun-hits",
  StunPerEligibleHit = "stun-per-hit",
  StunPerSecond = "stun-per-second",
  Overcap = "overcap",
  DamagePercentage = "percentage",
}

/** A column plus whether it's currently shown. Column lists persist EVERY column
 * of the set in a user-chosen order; hiding a column flips `visible` and leaves
 * it in place (it just stops rendering) instead of moving it out of the list. */
export type ColumnSetting<T extends string> = { id: T; visible: boolean };

/** The shown columns, in order — what the meter / skill tables actually render. */
export const visibleColumns = <T extends string>(settings: ColumnSetting<T>[]): T[] =>
  settings.filter((setting) => setting.visible).map((setting) => setting.id);

/** All player columns except the always-on Name column, in enum order. */
export const ALL_METER_COLUMNS: MeterColumns[] = Object.values(MeterColumns).filter(
  (column) => column !== MeterColumns.Name
);
/** All skill-breakdown columns, in enum order. */
export const ALL_SKILL_COLUMNS: SkillColumns[] = Object.values(SkillColumns);

/** Build a column-settings list: the `shown` columns first (in order, visible),
 * then every remaining column of `universe` appended as hidden. */
export const buildColumns = <T extends string>(universe: T[], shown: T[]): ColumnSetting<T>[] => {
  const rest = universe.filter((column) => !shown.includes(column));
  return [...shown, ...rest].map((id) => ({ id, visible: shown.includes(id) }));
};

/** Reconcile a persisted column list against the current column `universe`,
 * preserving the user's order and per-column visibility. Columns no longer in
 * the universe (or explicitly `removed`) are dropped; columns added to the
 * universe since the list was saved are appended as hidden. Run on every
 * hydration so a newly-added column always becomes reachable in the picker even
 * for users whose stored list predates it (the persist `version` only bumps on
 * shape changes, so migration alone can't cover new members). */
export const reconcileColumns = <T extends string>(
  existing: ColumnSetting<T>[],
  universe: T[],
  removed: string[] = []
): ColumnSetting<T>[] => {
  const known = existing.filter(
    (setting) => (universe as string[]).includes(setting.id) && !removed.includes(setting.id)
  );
  const present = new Set(known.map((setting) => setting.id));
  const appended = universe
    .filter((id) => !present.has(id) && !removed.includes(id))
    .map((id) => ({ id, visible: false }));
  return [...known, ...appended];
};

/** Overlay (live meter) default player columns — lean, to fit the narrow window.
 * The Name column is always shown and is not part of this list. */
export const DEFAULT_OVERLAY_COLUMNS: ColumnSetting<MeterColumns>[] = buildColumns(ALL_METER_COLUMNS, [
  MeterColumns.TotalDamage,
  MeterColumns.DPS,
  MeterColumns.StunPerSecond,
  MeterColumns.DamagePercentage,
]);

/** Main-window (logs / quest-details) default player columns. */
export const DEFAULT_LOGS_COLUMNS: ColumnSetting<MeterColumns>[] = buildColumns(ALL_METER_COLUMNS, [
  MeterColumns.TotalDamage,
  MeterColumns.DPS,
  MeterColumns.TotalStunValue,
  MeterColumns.StunPerSecond,
  MeterColumns.SupPercentage,
  MeterColumns.DamagePercentage,
]);

/** Overlay (live meter) default skill-breakdown columns — lean. */
export const DEFAULT_OVERLAY_SKILL_COLUMNS: ColumnSetting<SkillColumns>[] = buildColumns(ALL_SKILL_COLUMNS, [
  SkillColumns.Hits,
  SkillColumns.TotalDamage,
  SkillColumns.MinDamage,
  SkillColumns.MaxDamage,
  SkillColumns.AverageDamage,
  SkillColumns.StunPerSecond,
  SkillColumns.DamagePercentage,
]);

/** Main-window (logs / quest-details) default skill-breakdown columns — full set. */
export const DEFAULT_LOGS_SKILL_COLUMNS: ColumnSetting<SkillColumns>[] = buildColumns(ALL_SKILL_COLUMNS, [
  SkillColumns.Hits,
  SkillColumns.TotalDamage,
  SkillColumns.MinDamage,
  SkillColumns.MaxDamage,
  SkillColumns.AverageDamage,
  SkillColumns.TotalStunValue,
  SkillColumns.StunEligibleHits,
  SkillColumns.StunPerEligibleHit,
  SkillColumns.StunPerSecond,
  SkillColumns.Overcap,
  SkillColumns.DamagePercentage,
]);

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

/** Toolbox / Synthesis Helper — mirrors src-tauri/src/synthesis/mod.rs. */
export type SynthesisSigil = {
  uid: number;
  sigilId: number;
  trait1: number;
  trait1Level: number;
  trait2: number;
  trait2Level: number;
};

export type SynthesisPrediction = {
  trait1: number;
  trait2: number | null;
  lucky: boolean;
};

export type SynthesisMatch = {
  sigilA: SynthesisSigil;
  sigilB: SynthesisSigil;
  prediction: SynthesisPrediction;
  resultSigilId: number | null;
};

export type SynthesisStatus = {
  gameRunning: boolean;
  sigilCount: number;
  rngUnpredictable: boolean;
};

export type SynthesisSearchResponse = {
  matches: SynthesisMatch[];
  pairsTested: number;
  sigilCount: number;
  rngUnpredictable: boolean;
  /** Seed identity the search was computed from (staleness detection). */
  rngState: number;
  seedCounter: number;
};

/** Live synthesis seed identity (fetch_synthesis_seed; null = game not running). */
export type SynthesisSeed = {
  rngState: number;
  seedCounter: number;
};

/** Toolbox / Overmastery Predictor — mirrors src-tauri/src/overmastery/mod.rs. */
export type OvermasteryStatus = {
  gameRunning: boolean;
  /** Character id hashes (custom-XXHash32 of "PL####") in roster order. */
  roster: number[];
};

export type OvermasteryMastery = {
  /** MED_EFF_* key hash — translatable via overmasteries.json. */
  category: number;
  /** 1..10 as shown in game. */
  level: number;
  /** Effect id: 0=ATK, 1=HP, 2=Crit, 3=Stun, 100+ specials. */
  kind: number;
  value: number;
};

export type OvermasteryPrediction = {
  rolls: OvermasteryMastery[][];
  slot: number;
  slotState: number;
  unpredictable: boolean;
  mspCost: number;
};

/** Mirror of LinuxSetupStatus in src-tauri/src/main.rs. */
export type LinuxSetupStatus = {
  steamFound: boolean;
  gameDir: string | null;
  prefixFound: boolean;
  proxyStatus: "missing" | "current" | "outdated" | "foreign";
  launchOptions: string;
};
