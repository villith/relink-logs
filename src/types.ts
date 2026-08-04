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
  /** The game's own actor index for this spawn.
   *
   * `id` is the spawn's instance pointer folded to 32 bits, which is what tells
   * two simultaneous same-kind actors apart; this is the coarser index the
   * STATUS events report, and the only field the damage and status capture
   * paths share. Present so a debuff can be matched to the enemy holding it —
   * see `StatusInterval.targetSegment`. */
  actorIndex: number;
  enemyType: EnemyType;
  instance: number;
  maxHp: number | null;
  startMs: number;
  endMs: number;
};

/** One distinct (source, target, ability) combination present in the log,
 * computed with the time window applied but the selector pins not applied.
 * Mirrors the Rust `SelectionFact`.
 *
 * `sourceActorType`/`sourceIndex` are the PARENT actor, so a summon's hit is
 * offered under the player who called it. */
export type SelectionFact = {
  sourceActorType: number;
  sourceIndex: number;
  /** Index into `targetEntries` — the SPAWN this hit landed on, never the
   * game's actor id.
   *
   * The game reissues a dead boss's actor id to a later one ("Four Dragons of
   * the Apocalypse": Wilinus Icewyrm and Vrazarek Firewyrm both arrived as
   * 3926405961). Keyed by that id the two collapsed into one dropdown entry,
   * the second dragon never appeared at all, and pinning the first showed both
   * dragons' damage. */
  targetSegment: number;
  ability: ActionType;
  /** The body the hit came from, filed the way `skillBreakdown` files it — so
   * the ability selector can condense into skill groups with the same rule the
   * table uses. Optional: a backend older than the field sends nothing, and the
   * list then stays ungrouped rather than mis-grouping. */
  childCharacterType?: CharacterType;
};

/** Which source actors and abilities the analysis view's selector bar has
 * pinned, sent back as a filter. Empty on a dimension means "All"; the
 * dimensions are ANDed. Mirrors the Rust `SelectionFilter`. */
export type SelectionFilter = {
  /** Source actor INDICES, not actor-type hashes: a hash names a character
   * class, and an online party can hold two of the same character. */
  sourceIndices: number[];
  abilities: ActionType[];
};

/** The selectable slice of a TargetEntry, sent back as a filter. */
export type TargetSpan = {
  id: number;
  startMs: number;
  endMs: number;
};

/**
 * Which contested damage sources the meters count (mirrors the Rust
 * `MeterFilters`, camelCase to match its serde rename).
 *
 * Sits beside `TargetSpan` because the two travel together as the parser's
 * `ParseOptions`. Build one with `useMeterFilters` rather than writing the
 * object literal at each call site — every flag has to reach all of them.
 */
export type MeterFilters = {
  includePrimalBurst: boolean;
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

/**
 * One band of the analysis view's ability drill-down chart (mirrors the Rust
 * `AbilityChartSeries`): what one breakdown row of the pinned player dealt per
 * second. Keyed exactly as a `skillBreakdown` row is — same action, same child
 * character — so a band always corresponds to a row of the table beneath it and
 * both fold into skill groups by the same rule.
 *
 * Present only on a scoped fetch that pinned a source; empty otherwise.
 */
export type AbilityChartSeries = SkillRow & {
  values: number[];
};

/**
 * One band of the target drill-down chart (mirrors the Rust
 * `TargetChartSeries`): what the pinned ability dealt to one enemy spawn per
 * second. Carries the spawn's `instance`, so a band names the same enemy the
 * target dropdown and the HP chart do.
 */
export type TargetChartSeries = {
  enemyType: EnemyType;
  instance: number;
  values: number[];
};

/**
 * One window during which one actor held one status effect (mirrors the Rust
 * `StatusInterval`).
 *
 * Per actor and never merged: a union across the party cannot be un-merged, so
 * pinning a buff could never show which players had it. Uptime is computed from
 * these in the frontend — see `statusUptime` — which is also what makes two
 * overlapping sources read as 100% rather than 200%.
 */
export type StatusInterval = {
  actorIndex: number;
  casterIndex: number | null;
  statusId: number;
  /** Null when the hook could not resolve the causing ability. The row then
   * falls back to the bare effect name rather than disappearing. */
  abilityId: number | null;
  startMs: number;
  endMs: number;
  /** Peak stacks within the window. Carried for the chart, which is where a
   * stack count belongs — it varies over the window, so a table cell cannot
   * say anything true about it. A status the generated `status_levels` table
   * does not mark HasLevels reports 1: whatever sits at the count offset for
   * those is not a count (see `stacks_for` in the hook). */
  maxStacks: number;
  /** Which enemy SPAWN held this, as an index into `targetEntries`. Null for a
   * player, and for an enemy the segmenter skipped (a phantom marker actor).
   *
   * The spawn rather than `actorIndex` for the reason the damage path already
   * pins targets by segment: the game reissues a dead boss's actor id to the
   * next one, so a debuff open when the first dragon died was extended by the
   * second dragon's apply into one row spanning both fights. */
  targetSegment: number | null;
  /** How many times the effect landed in this window — the apply plus every
   * refresh merged into it. Summed across holders, this is the Count column. */
  applications: number;
};

/** Everything grouping and naming read of a hit: the action and the body it came
 * from.
 *
 * Narrower than `SkillState` on purpose — a chart band carries these two fields
 * and a bucket array, nothing else, so it satisfies this structurally instead of
 * needing a cast that would hide a real drift between a band and a row. */
export type SkillRow = Pick<SkillState, "actionType" | "childCharacterType">;

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
  /** Skybound Arts gauge this skill generated. Local player only — a remote
   * member's gauge is synced rather than granted by a hit the hook can see, so
   * their rows are 0 and the table must say so rather than ranking them.
   * Optional: a backend older than the field sends nothing (dev HMR skew). */
  sbaGenerated?: number;
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
  /** Total gauge generated over the fight — the sum of every recorded gauge
   * increase. Ranks contribution; `sba` above is the LEVEL, which reads 0 right
   * after a burst. Optional: a backend older than the field sends nothing (dev
   * HMR skew) — never a stored-log concern, since logs are always reparsed by
   * the running backend. */
  sbaGenerated?: number;
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
  /** SBA generated by causes that are not the player's own damaging hits, one
   * entry per (kind, id). Optional: a payload from an older backend has none. */
  sbaSources?: SbaSourceState[];
  /** Number of hits by this player that reached the game's damage cap */
  cappedHits: number;
  /** Number of hits by this player that were subject to a damage cap at all */
  cappableHits: number;
  /** Sum of pre-cap base damage over cappable hits (for overcap %: baseSum/capSum*100) */
  overcapBaseSum: number;
  /** Sum of damage caps over cappable hits */
  overcapCapSum: number;
};

/** A cause of SBA generation that no skill row can hold — mirrors the Rust
 * `SbaSourceState`. `kind` is a stable machine key; the table maps it to an
 * i18n key rather than displaying it. */
export type SbaSourceState = {
  kind: "damageTaken" | "perfectGuard" | "effect" | "partyAward" | "directorAward" | "questStart" | "site" | "unknown";
  id: number | null;
  generated: number;
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

export type EncounterStatus = "InProgress" | "Stopped";

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
 * follow the pre-2.0 PlayerStats layout the block mirrors; unk50 is the one
 * still-unconfirmed slot. */
export type RecordStats = {
  level: number;
  hp: number;
  attack: number;
  unk50: number;
  stunPower: number;
  /** Critical hit rate, percent. Read as an integer before 2026-07-24;
   * older logs recover the correct value on reparse. */
  criticalRate: number;
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
   * `unk50` is the one still-unlabeled slot (see the Rust-side docs). */
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
  /** Copied in from another installation's logs.db, so it may lack data the
   * source app never recorded. Optional so a backend older than the field
   * (dev HMR skew) reads as "not imported" rather than breaking the list. */
  imported?: boolean;
  /** Id of the first run of the Repeat Quest chain this log belongs to (null
   * on the chain's first run and on unchained logs). Optional for the same
   * backend-skew reason as `imported`: absent reads as "not chained". */
  repeatGroup?: number | null;
};

/** Result of merging another installation's logs.db into ours
 * (`import_logs_from_file`). */
export type ImportSummary = {
  imported: number;
  duplicates: number;
  unreadable: number;
  filtered: number;
};

/** Payload of the `import-progress` event emitted while `analyze_logs_db` or
 * `import_logs_from_file` works through a source file. */
export type ImportProgress = {
  processed: number;
  total: number;
};

/** One source row, as the import dialog's example tooltips draw it. */
export type ImportLogExample = {
  time: number;
  duration: number;
  questId: number | null;
};

/** Dry-run report for a logs.db import (`analyze_logs_db`): what would come
 * across, and — of those logs — how many carry each kind of data. */
export type ImportAnalysis = {
  total: number;
  importable: number;
  duplicates: number;
  unreadable: number;
  filtered: number;
  /** Up to 5 example rows per classification, for the summary tooltips. */
  examples: {
    total: ImportLogExample[];
    duplicates: ImportLogExample[];
    unreadable: ImportLogExample[];
    filtered: ImportLogExample[];
    importable: ImportLogExample[];
  };
  withPartyNames: number;
  withEquipment: number;
  withEnemyHp: number;
  withOvercap: number;
  withDeaths: number;
  withStunEvents: number;
  withSbaEvents: number;
  withQuest: number;
  withQuestTime: number;
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
  /** Item-config record level; backend implementation detail, unused in UI. */
  recordLevel: number;
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

/** Toolbox / Transmarvel Wishlist — mirrors src-tauri/src/transmarvel/mod.rs. */
export type TransmarvelStatus = {
  gameRunning: boolean;
  rngUnpredictable: boolean;
};

export type TransmarvelOutcome =
  | { type: "sigil"; sigilId: number; traitLevel: number; trait1: number; trait2: number | null }
  | { type: "wrightstone"; item: number; traits: [number, number][] };

export type TransmarvelRoll = {
  outcome: TransmarvelOutcome;
  draws: number;
};

export type TransmarvelPrediction = {
  rolls: TransmarvelRoll[];
  slot: number;
  slotState: number;
  unpredictable: boolean;
};

/** Mirror of LinuxSetupStatus in src-tauri/src/main.rs. */
export type LinuxSetupStatus = {
  steamFound: boolean;
  gameDir: string | null;
  prefixFound: boolean;
  proxyStatus: "missing" | "current" | "outdated" | "foreign";
  launchOptions: string;
};

/** Mirrors `HookState` in src-tauri/src/toolbox_rpc.rs. `unresponsive` is
 * "connected, but the hook is not answering the toolbox channel" — its version
 * is unknown, which is NOT the same claim as `outOfDate`. */
export type HookState = "connected" | "reconnecting" | "outOfDate" | "unresponsive" | "dllMissing" | "disconnected";

export interface HookStatusSnapshot {
  state: HookState;
  hookVersion: string | null;
  appVersion: string;
  supportsEject: boolean;
}

/* Build legality. Mirrors `src-tauri/src/legality`'s `Finding` and the stored
 * rows `src-tauri/src/db/legality.rs` serves. */

/** `legality::Rule`, spelled as a closed union so adding or renaming a rule in
 * Rust fails `tsc` here rather than silently rendering an untranslated id.
 * Each name must have a `ui.legality.limit.<name>` key — that is what
 * `describeLimit` reads and what `legalityStrings.test.ts` enforces. (There is
 * no per-rule LABEL namespace any more: findings name themselves through the
 * gear line the limit sits under.) */
export type LegalityRule =
  | "wrightstoneTraitLevel"
  | "wrightstoneTrait"
  | "sigilTraitLevel"
  | "sigilLockedPair"
  | "sigilQuestLockedTrait"
  | "sigilSingleTraitOnly"
  | "overmasteryValue"
  | "overmasteryAllMaxed"
  | "summonTrait"
  | "summonBonusSource"
  | "summonBonusMagnitude"
  | "summonPerfectCount"
  | "masterTraitCount";

/** `legality::Subject`, an internally tagged enum: `index` is absent for the
 * variants that carry none (`wrightstone`). */
export type LegalitySubject = {
  kind: "wrightstone" | "sigil" | "summon" | "overmastery" | "overmasteries" | "summons" | "masterTraits";
  index?: number;
};

/** `legality::Value`, adjacently tagged so ids and levels are told apart. Ids
 * carry their CATALOGUE in the tag — one kind per namespace — so the renderer
 * never has to infer which translate helper resolves them from the paired
 * rule. */
export type LegalityValue =
  | { kind: "level" | "count" | "amount" | "traitId" | "summonBonusId" | "overmasteryId"; value: number }
  /** `summonBonusIds` is legacy — it survives only so findings stored before
   * the bonus-source rule started naming its owners still deserialize.
   * `summonIds` replaced it: one id per display NAME, the summons that DO grant
   * a bonus some other summon was caught holding. */
  | { kind: "levels" | "traitIds" | "sigilIds" | "summonBonusIds" | "summonIds"; value: number[] }
  | { kind: "none" };

/** One trait or bonus line beneath its item — `legality::EvidenceTrait`. */
export type LegalityEvidenceTrait = { id: number; level: number };

/** One equipped summon — `legality::EvidenceSummon`. */
export type LegalityEvidenceSummon = {
  summonId: number;
  main: LegalityEvidenceTrait;
  bonus: LegalityEvidenceTrait;
};

/** One overmastery. `flags` decides whether the magnitude is a level or an
 * amount, so it must survive to the formatter — `legality::EvidenceOvermastery`. */
export type LegalityEvidenceOvermastery = { id: number; value: number; flags: number };

/**
 * The equipment a finding is about, captured when the finding was computed —
 * `legality::Evidence`.
 *
 * This is what makes a stored verdict self-describing. `LegalitySubject` alone
 * carries a slot index, which is meaningless without the encounter it indexes
 * into; rendering it against any other build names whichever item now sits in
 * that slot. With the snapshot the page needs no encounter at all.
 */
export type LegalityEvidence =
  | { kind: "sigil"; sigilId: number; level: number; traits: LegalityEvidenceTrait[] }
  | { kind: "wrightstone"; wrightstoneId: number; traits: LegalityEvidenceTrait[] }
  | ({ kind: "summon" } & LegalityEvidenceSummon)
  | { kind: "summons"; summons: LegalityEvidenceSummon[] }
  | ({ kind: "overmastery" } & LegalityEvidenceOvermastery)
  | { kind: "overmasteries"; entries: LegalityEvidenceOvermastery[] }
  | { kind: "masterTraits"; observed: number; allowed: number };

export type LegalityFinding = {
  rule: LegalityRule;
  subject: LegalitySubject;
  observed: LegalityValue;
  allowed: LegalityValue;
  /** Absent on rows written before the snapshot existed; the sweep refills
   * them, and a finding without one simply names nothing. */
  evidence?: LegalityEvidence | null;
  /** Probability of occurring legitimately. Null for a hard table breach,
   * which has no odds to quote.
   *
   * Severity is gone, so this is the only thing separating a report of long
   * odds from proof the game could not have produced a build — a surface that
   * shows findings must show these odds wherever they exist. */
  odds: number | null;
};

/** One stored finding with the party slot it belongs to — `db::legality::StoredFinding`.
 *
 * The quest list reads these: it draws a party as text rather than as the
 * players themselves, so it needs the slot to know which name to colour. */
export type StoredLegalityFinding = {
  /** Party slot 0-3, the same index the encounter's player data uses. */
  playerIndex: number;
  displayName: string;
  characterType: CharacterType;
  finding: LegalityFinding;
};

/** One stored finding with the encounter it came from — `db::legality::PlayerFinding`. */
export type LegalityPlayerFinding = {
  logId: number;
  /** Milliseconds since the UNIX epoch. */
  time: number;
  /** The quest the encounter was, so the audit page can name each flagged fight
   * without loading it. Absent on a log recorded before the column existed. */
  questId?: number | null;
  finding: LegalityFinding;
};

/** Everything the audit page shows for one person — `db::legality::FlaggedPlayer`.
 *
 * Grouped by name AND character, so one human on one character is a single row
 * however many party slots they have occupied. */
export type LegalityFlaggedPlayer = {
  displayName: string;
  characterType: CharacterType;
  /** Distinct encounters flagged, not findings. A tiebreaker on the page's
   * ordering; the page does not draw it as a badge. */
  encounters: number;
  /** Most recent flagged encounter, milliseconds since the UNIX epoch. */
  lastSeen: number;
  findings: LegalityPlayerFinding[];
};

/** Progress of the startup rescan — `LegalitySweepProgress` in main.rs, pushed
 * on the `legality-sweep-progress` event. `done === total` means finished. */
export type LegalitySweepProgress = {
  done: number;
  total: number;
};
