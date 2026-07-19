/*!
This library crate provides the event protocol that is emitted by the "hook"
injected into the game process and consumed by the Relink Logs parser.

Keep in mind that the serialization protocol is not defined here, only the
serializable message types.

The protocol between the hook and the parser is a simple named pipe, where the
messages are encoded as "bincode" serialized bytes. This means that the hook and
the parser must be compiled together to ensure that the serialization format is
the same.

The parser saves these messages in a different serialization format that provides
forward-compatibility so that old logs can still be read by newer versions of the
parser.

Because of this, any changes to the protocol must be done carefully to ensure that
the parser can still read old logs. This is done by adding new fields to the existing
message types, or adding new message types that are ignored by the parser
*/

use core::fmt;
use std::{
    ffi::CString,
    fmt::{Display, Formatter},
};

pub use bincode;

use serde::{Deserialize, Serialize};

pub const PIPE_NAME: &str = r"\\.\pipe\gbfr-logs";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Actor {
    /// Index of the actor, unique in the party.
    pub index: u32,
    /// Hash ID of the actor.
    pub actor_type: u32,
    /// Index of the actor's parent. If no parent, then it's the same as `index`.
    pub parent_index: u32,
    /// Hash ID of this actor's parent. If no parent, then it's the same as `actor_type`.
    pub parent_actor_type: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Copy)]
pub enum ActionType {
    /// Link Attack
    LinkAttack,
    /// Skybound Arts
    SBA,
    /// Supplementary Damage containing the original skill ID that trigged it.
    SupplementaryDamage(u32),
    /// Damage over time, containing the effect type. (Currently, always 0 until we find more info)
    DamageOverTime(u32),
    /// Normal Skill Attack containing the skill ID.
    Normal(u32),
}

impl Display for ActionType {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            ActionType::LinkAttack => write!(f, "Link Attack"),
            ActionType::SBA => write!(f, "Skybound Arts"),
            ActionType::SupplementaryDamage(id) => write!(f, "Supplementary Damage ({})", id),
            ActionType::DamageOverTime(id) => write!(f, "Damage Over Time ({})", id),
            ActionType::Normal(id) => write!(f, "Skill ({})", id),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DamageEvent {
    pub source: Actor,
    pub target: Actor,
    pub damage: i32,
    pub flags: u64,
    pub action_id: ActionType,
    pub attack_rate: Option<f32>,
    pub stun_value: Option<f32>,
    pub damage_cap: Option<i32>,
    /// Pre-cap base damage (the value before `min(base, cap)` clamps it), read
    /// from the game's DamageInstance (+0x2D4, v2.0.2). `None` on old logs and on
    /// hooks that don't provide it. Lets the parser compute exact cap detection
    /// (`base > cap`) and the game's overcap %: `(base / cap) * 100`.
    pub base_damage: Option<f32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Sigil {
    pub first_trait_id: u32,
    pub first_trait_level: u32,
    pub second_trait_id: u32,
    pub second_trait_level: u32,
    pub sigil_id: u32,
    pub equipped_character: u32,
    pub sigil_level: u32,
    pub acquisition_count: u32,
    pub notification_enum: u32,
}

/// One equipped summon, read from the player record (v2.0.2 expansion: 4
/// account-level summons whose bonuses apply party-wide). Ids are game hashes:
/// `summon_id` keys `summon.tbl`, `main_trait_id` is an ordinary trait id (the
/// `traits:` lang namespace names it), `bonus_id` keys `summon_base_param.tbl`.
/// `bonus_level` is 0-indexed against that table's ten LevelNValue columns.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EquippedSummon {
    pub summon_id: u32,
    pub main_trait_id: u32,
    pub main_trait_level: u32,
    pub bonus_id: u32,
    pub bonus_level: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WeaponInfo {
    /// Weapon ID Hash
    pub weapon_id: u32,
    /// How many uncap stars the weapon has
    pub star_level: u32,
    /// Number of plus marks on the weapon
    pub plus_marks: u32,
    /// Weapon's awakening level
    pub awakening_level: u32,
    /// First trait ID
    pub trait_1_id: u32,
    /// First trait level
    pub trait_1_level: u32,
    /// Second trait ID
    pub trait_2_id: u32,
    /// Second trait level
    pub trait_2_level: u32,
    /// Third trait ID
    pub trait_3_id: u32,
    /// Third trait level
    pub trait_3_level: u32,
    /// Wrightstone used on the weapon
    pub wrightstone_id: u32,
    /// Current weapon level
    pub weapon_level: u32,
    /// Weapon's HP Stats (before plus marks)
    pub weapon_hp: u32,
    /// Weapon's Attack Stats (before plus marks)
    pub weapon_attack: u32,
}

/// Overmastery, also known as `limit_bonus`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Overmastery {
    /// Overmastery ID
    pub id: u32,
    /// Flags
    pub flags: u32,
    /// Value
    pub value: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OvermasteryInfo {
    pub overmasteries: Vec<Overmastery>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerStats {
    pub level: u32,
    pub total_hp: u32,
    pub total_attack: u32,
    pub stun_power: f32,
    pub critical_rate: f32,
    pub total_power: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerLoadEvent {
    pub sigils: Vec<Sigil>,
    pub character_name: CString,
    pub display_name: CString,
    pub character_type: u32,
    pub party_index: u8,
    pub actor_index: u32,
    pub is_online: bool,
    pub weapon_info: WeaponInfo,
    pub overmastery_info: OvermasteryInfo,
    pub player_stats: PlayerStats,
}

/// Minimal player metadata resolved from the identity snapshot alone.
///
/// The full [`PlayerLoadEvent`] reads sigils, weapon, overmastery and stats from
/// equipment layouts that shifted in the 2.0 update and are not yet re-derived.
/// This event carries only the always-available identity fields (name, party
/// slot, online flag) so the meter can distinguish players — in particular two
/// players on the same character, and online players that would otherwise show
/// as `[Guest]` — without manufacturing empty equipment data.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerIdentityEvent {
    pub character_name: CString,
    pub display_name: CString,
    pub character_type: u32,
    pub party_index: u8,
    pub actor_index: u32,
    pub is_online: bool,
    /// Equipped sigils recovered from the identity snapshot (v2.0.2+: the snapshot
    /// leads with 13 sigil entries). Empty when the snapshot carried no resolvable
    /// sigil data; `#[serde(default)]` keeps pre-existing stored logs readable.
    #[serde(default)]
    pub sigils: Vec<Sigil>,
    /// The 4 equipped summons read inline from the player record (+0x5DD8,
    /// live-verified 2026-07-17). Account-level — every record of a local party
    /// carries the same set. Empty for records with no populated slots;
    /// `#[serde(default)]` keeps pre-existing stored logs readable.
    #[serde(default)]
    pub summons: Vec<EquippedSummon>,
    /// The 4 equipped overmasteries. Primary source is the record's inline block
    /// (`record+0x58B8`, 4 × `{u32 id, u32 level_bits, u32 effect_idx, f32 value}`,
    /// live-verified 2026-07-17) which populates in-quest for every party slot and
    /// carries the computed magnitude in [`Overmastery::value`]; when that block is
    /// still sentinel-empty the town loadout pairs (`*(record+0x5DC8)+0x3208`,
    /// id+level only, `value` 0.0) stand in. `level_bits` is a single-bit flag:
    /// bit N → level N+1 (max bit 9 = level 10); carried in [`Overmastery::flags`].
    /// `#[serde(default)]` keeps pre-existing stored logs readable.
    #[serde(default)]
    pub overmasteries: Vec<Overmastery>,
    /// Character level: the record's level input (`record+0x5B44`, populated
    /// in-quest) with the town loadout (`*(record+0x5DC8)+0x3530`) as fallback.
    /// 0 when unavailable; `#[serde(default)]` keeps pre-existing stored logs
    /// readable.
    #[serde(default)]
    pub player_level: u32,
    /// The 4 equipped ability (skill) ids inline in the record
    /// (`record+0x5AF4..0x5B04`, live-verified 2026-07-17). Values are game
    /// hashes of `AB_PL####_##` action names. Empty when unpopulated;
    /// `#[serde(default)]` keeps pre-existing stored logs readable.
    #[serde(default)]
    pub abilities: Vec<u32>,
    /// Equipped weapon identity as the full game key name, e.g.
    /// `WEP_PL2700_02_01` (weapon.tbl `Key`). Resolved by walking the
    /// charid-keyed equipped-state map in the save root (`*(DAT_147c24980)`,
    /// map header +0x40/+0x50/+0x68; entry+0x00 holds the id as 0x10-byte
    /// ASCII "PPPP_WW_UU", live-verified 2026-07-17). Empty when the record's
    /// charid has no entry; `#[serde(default)]` keeps stored logs readable.
    #[serde(default)]
    pub weapon_key: String,
    /// Master level, combined level+stars as the game stores it
    /// (`record+0x5B60`; 55 = level 50 + 5 stars, live-verified for the local
    /// player — AI companion records read 0). `#[serde(default)]` keeps
    /// pre-existing stored logs readable.
    #[serde(default)]
    pub master_level: u32,
    /// Unlocked skillboard (master trait) node effect ids. Reimplements the
    /// game's own query (`FUN_140297bc0`, decompiled 2026-07-17): CharaPower
    /// (`*(DAT_147c24a78)`) maps charid → node-key vector (map header
    /// +0x728/+0x738/+0x750); each key resolves through the node map
    /// (+0x330/+0x348/+0x320) to a row whose unlock bit (`row+0x5C`) is tested
    /// against the record's inline 400×0x38 `{id, bits}` array at
    /// `record+0x138`; unlocked rows contribute `row+0x74` (the same id space
    /// as the network profile blob's 50-id list). Empty when CharaPower has no
    /// entry for the charid (e.g. remote players). `#[serde(default)]` keeps
    /// stored logs readable.
    #[serde(default)]
    pub skillboard: Vec<u32>,
    /// The record's inline stat block (`record+0x5B44..0x5B60`, decompiled from
    /// the dispatcher `FUN_140a23e70` case-3 fill and the town loadout-apply
    /// `FUN_1407a1080`: loadout+0x3530..0x3550 maps 1:1 onto it). Field labels
    /// follow the pre-2.0 `PlayerStats` layout, which the block mirrors
    /// (level, hp, attack, ?, stun f32, ?, power); pending one live-run
    /// confirmation against the status screen. `None` when unpopulated;
    /// `#[serde(default)]` keeps stored logs readable.
    #[serde(default)]
    pub stats: Option<RecordStats>,
    /// The equipped weapon's full state (id, progression, wrightstone and
    /// active innate traits). Live-labeled 2026-07-17 against the user's
    /// Hraesvelgr: the record's `+0x5E80` blob (online contexts) carries it at
    /// blob+0x50, and the per-character save rows
    /// (`*(DAT_147c24980)+0x129B08` map, 0x190 stride) carry the identical
    /// struct at row+0x70. `None` when neither source resolves;
    /// `#[serde(default)]` keeps stored logs readable.
    #[serde(default)]
    pub weapon_state: Option<WeaponState>,
}

/// One trait id/level pair (wrightstone or innate weapon skill).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WeaponTraitPair {
    /// Trait id (`SKILL_*` hash, the `traits` lang namespace).
    pub id: u32,
    /// Trait level; 0 when not (yet) known.
    pub level: u32,
}

/// The v2.0.2 record-inline stat block. Labels tentative (see
/// [`PlayerIdentityEvent::stats`]): `hp`/`attack`/`stun_power`/`power` follow
/// the old `PlayerStats` field order; `unk_50`/`unk_58` are the two slots whose
/// meaning is still unconfirmed (old layout suggests `unk_50` = the pre-2.0
/// `unk_0c` filler and `unk_58` = critical rate).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RecordStats {
    /// Character level (`record+0x5B44`).
    pub level: u32,
    /// `record+0x5B48` — total/base HP (label pending live confirm).
    pub hp: u32,
    /// `record+0x5B4C` — total/base attack (label pending live confirm).
    pub attack: u32,
    /// `record+0x5B50` — unknown (town-filled only).
    pub unk_50: u32,
    /// `record+0x5B54` — stun power (the block's only float, matching the old
    /// layout's stun_power f32).
    pub stun_power: f32,
    /// `record+0x5B58` — unknown (critical rate candidate).
    pub unk_58: u32,
    /// `record+0x5B5C` — total power / power level candidate (town-filled).
    pub power: u32,
}

/// The equipped weapon's state (see [`PlayerIdentityEvent::weapon_state`]).
///
/// Struct layout in game memory (u32 indices into blob+0x50 / row+0x70,
/// live-labeled against a maxed Hraesvelgr — Stun Power 20 / ATK 15 /
/// Provoke 10 wrightstone, Catastrophe Nova / Glass Cannon / DMG Cap /
/// Sigil Booster innate skills): `[1]` weapon.tbl Key hash (incl. the
/// transcendence variant, e.g. `WEP_PL2700_06_03`), `[4]` exp, `[5]` uncap
/// stars, `[6]` plus marks, `[7]` awakening level, `[8..13]` the three
/// wrightstone `{id, level}` pairs, `[14]` wrightstone item id
/// (`ITEM_25_####`). Active innate skill ids: blob+0x94 (5 slots,
/// sentinel-terminated) or, on the save-row path, resolved from the id at
/// row+0xB4 through the static weapon-skill table `*(DAT_147c24af8)+0x370`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WeaponState {
    /// weapon.tbl Key hash of the equipped weapon (transcendence-variant row).
    pub weapon_id: u32,
    /// Current weapon exp.
    pub exp: u32,
    /// Uncap star count.
    pub star_level: u32,
    /// Plus marks (+0..99).
    pub plus_marks: u32,
    /// Awakening level (0..10).
    pub awakening_level: u32,
    /// Wrightstone item id (`ITEM_25_####` hash; 0 when none equipped).
    pub wrightstone_id: u32,
    /// The wrightstone's up-to-3 trait id/level pairs.
    pub wrightstone_traits: Vec<WeaponTraitPair>,
    /// The weapon's ACTIVE innate skills (awakening/transcendence variants
    /// already applied by the game — these can differ from the base
    /// weapon-table skills). Levels are 0 until their storage is located.
    pub innate_traits: Vec<WeaponTraitPair>,
}

/// Emitted on each Conflux room load. The reception dispatcher rebuilds an
/// EndlessMode flow once per ROOM (the flow slot resets to null each room), so
/// this fires per room — NOT per run. Run identity is derived by the parser from
/// `manager_ptr`: the `EndlessModeQuestManager` pointer is stable across a run's
/// rooms and changes between runs, so a room whose `manager_ptr` differs from the
/// active run's (or arrives with no active run) opens a new run.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxRoomEnterEvent {
    /// The room's quest identifier (0 if not resolvable at emit time).
    pub quest_id: u32,
    /// `EndlessModeQuestManager` pointer — the stable per-run identity.
    pub manager_ptr: u64,
}

/// Emitted when a Conflux upgrade/buff installs on the player. `buff_id` is the
/// raw ability/buff identifier; single-player, so no player attribution.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxBuffAcquiredEvent {
    pub buff_id: u32,
}

/// Emitted when a Conflux run concludes (EndlessModeQuestManager destroyed).
/// Carries the manager pointer so the parser only finalizes the matching run.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConfluxRunEndEvent {
    /// `EndlessModeQuestManager` pointer being destroyed (matches the run's identity).
    pub manager_ptr: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AreaEnterEvent {
    /// Quest ID, last known. Could be stale if no other quest was ran while changing areas. 0 if no quest.
    pub last_known_quest_id: u32,
    /// Elapsed time in seconds, the in-game quest timer. Could be stale if no other quest was ran while changing areas.
    pub last_known_elapsed_time_in_secs: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QuestCompleteEvent {
    pub quest_id: u32,
    pub elapsed_time_in_secs: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnUpdateSBAEvent {
    pub actor_index: u32,
    pub sba_value: f32,
    pub sba_added: f32,
}

/// Whenever SBA is attempted, but not necessarily hit.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnAttemptSBAEvent {
    pub actor_index: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnPerformSBAEvent {
    pub actor_index: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnContinueSBAChainEvent {
    pub actor_index: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnDeathEvent {
    pub actor_index: u32,
    pub death_counter: u32,
}

/// Per-hit stun applied to an enemy, captured from the game's network stun-apply
/// message handler (v2.0.2 `FUN_140b43b40`). Online, enemy stun is
/// host-authoritative and lands via these messages asynchronously — the damage
/// hook's accumulator-delta method structurally reads 0 there — so this event is
/// the online stun source. `actor_index` is the per-player slot key of the source
/// (resolved through the message's entity handle); `stun_amount` is the measured
/// accumulator delta (ramp bonus and stun-cap clamping included).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnPlayerStunEvent {
    pub actor_index: u32,
    pub stun_amount: f32,
}

/// A quest ended without a result screen: the player confirmed retire/abandon
/// (the in-game retire-select flag was set), or the fail screen was reached.
/// `quest_id` is the hook's last-known quest id (0 = unknown, e.g. injected
/// mid-quest); the parser prefers the id stamped on the encounter at its own
/// load and uses this only as a fallback.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnQuestFailEvent {
    pub quest_id: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum Message {
    OnAreaEnter(AreaEnterEvent),
    OnQuestComplete(QuestCompleteEvent),
    DamageEvent(DamageEvent),
    OnUpdateSBA(OnUpdateSBAEvent),
    OnAttemptSBA(OnAttemptSBAEvent),
    OnPerformSBA(OnPerformSBAEvent),
    OnContinueSBAChain(OnContinueSBAChainEvent),
    PlayerLoadEvent(PlayerLoadEvent),
    OnDeathEvent(OnDeathEvent),
    /// Player name + actor mapping without version-sensitive equipment data.
    /// Used in 2.0 compatibility mode where the full player-load layout is unresolved.
    PlayerIdentityEvent(PlayerIdentityEvent),
    /// Conflux (EndlessMode) lifecycle. The reception dispatcher fires per ROOM, so
    /// run identity is derived by the parser from `ConfluxRoomEnterEvent::manager_ptr`
    /// (stable across a run's rooms). Run-end is the manager destructor.
    ConfluxRoomEnter(ConfluxRoomEnterEvent),
    ConfluxBuffAcquired(ConfluxBuffAcquiredEvent),
    ConfluxRunEnd(ConfluxRunEndEvent),
    OnPlayerStun(OnPlayerStunEvent),
    /// Appended last (bincode encodes the variant index — see the crate doc
    /// comment's append-only rule).
    OnQuestFail(OnQuestFailEvent),
}
