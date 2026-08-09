use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;
use chrono::Utc;
use protocol::{
    ActionType, AreaEnterEvent, ConfluxBuffAcquiredEvent, ConfluxRoomEnterEvent,
    ConfluxRunEndEvent, DamageEvent, Message, OnAttemptSBAEvent, OnContinueSBAChainEvent,
    OnDeathEvent, OnPerformSBAEvent, OnPlayerStunEvent, OnUpdateSBAEvent, PlayerIdentityEvent,
    PlayerLoadEvent, QuestCompleteEvent, QuestElapsedTimeEvent,
};

use crate::db::runs::{finalize_run, insert_run, ConfluxBuffDelta};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

use super::{
    constants::{CharacterType, EnemyType},
    v0,
};

mod ability_charts;
#[cfg(any(test, feature = "diag"))]
pub mod audit;
mod cap_detection;
mod chart_scope;
mod filters;
mod groups;
mod live_emit;
pub mod phantom_targets;
mod player_state;
mod sba_inference;
mod skill_state;
mod status;
mod windows;

pub use ability_charts::{build_ability_sba_chart, build_ability_stun_chart, AbilitySeries};
pub use chart_scope::ChartScope;
pub use filters::{is_excluded, matches_selection, MeterFilters, SelectionFilter};
pub use groups::{
    aggregate_group_reference, aggregate_groups, AbilityFilter, ActorRef, Dimension,
    GroupAggregate, GroupHostility, GroupKey, GroupMeasure, GroupMetric, GroupQuery,
    GroupQueryError, GroupReference, TimeWindow,
};
use phantom_targets::{is_excluded_target_type, PhantomTargets};
use player_state::{PlayerState, SbaSourceKind};
pub use status::{assemble_intervals, StatusInterval};
pub use windows::{
    assemble_chart_windows, corroborated_sba_activations, ChartWindow, ChartWindowKind,
};

pub struct AdjustedDamageInstance<'a> {
    pub event: &'a DamageEvent,
    pub player_data: Option<&'a PlayerData>,
    pub stun_damage: f64,
    pub is_capped: bool,
    /// Whether this hit is subject to a damage cap at all. Cap-less sources
    /// (supplementary damage, DoT, hits with no cap info) must count toward
    /// neither the capped-hit tallies nor their denominators.
    pub is_cappable: bool,
    /// The enemy SPAWN the hit landed on, as an index into the shared
    /// `segment_targets_indexed` segmentation — set only by the reparse walk,
    /// which has the full log to segment. The live path leaves it `None`
    /// (the overlay never reads per-spawn shares; the saved log is reparsed
    /// and comes out segmented).
    pub target_segment: Option<usize>,
}

impl<'a> AdjustedDamageInstance<'a> {
    /// Build an instance with exact cap detection from the game's pre-cap base
    /// damage (`base > cap`). This is the single authority for `is_capped`; there
    /// is no separate live-vs-history rule anymore.
    pub fn from_damage_event(event: &'a DamageEvent, player_data: Option<&'a PlayerData>) -> Self {
        let stun_damage = event.stun_value.unwrap_or(0.0) as f64;

        // Supplementary damage is never subject to the damage cap — the cap value it
        // carries belongs to the hit that triggered it. Newer hooks already strip the
        // cap at the source, but old logs recorded it, so it must be enforced here too.
        let is_supplementary = matches!(
            event.action_id,
            protocol::ActionType::SupplementaryDamage(_)
        );
        let is_cappable = !is_supplementary && event.damage_cap.is_some_and(|cap| cap > 0);
        let is_capped =
            is_cappable && cap_detection::is_capped(event.base_damage, event.damage_cap);

        Self {
            event,
            player_data,
            stun_damage,
            is_capped,
            is_cappable,
            target_segment: None,
        }
    }

    /// The `(base, cap)` pair to add to the overcap-% denominators for this hit,
    /// or `None` if the hit isn't cappable or carries no usable base/cap.
    pub fn overcap_contribution(&self) -> Option<(f64, f64)> {
        if !self.is_cappable {
            return None;
        }
        cap_detection::overcap_contribution(self.event.base_damage, self.event.damage_cap)
    }

    /// The reparse walk's way of stamping the shared spawn segmentation onto
    /// a hit without touching every other `from_damage_event` call site.
    pub fn with_target_segment(mut self, target_segment: Option<usize>) -> Self {
        self.target_segment = target_segment;
        self
    }
}

/// Equippable sigil for a character
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WeaponInfo {
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

impl From<protocol::WeaponInfo> for WeaponInfo {
    fn from(info: protocol::WeaponInfo) -> Self {
        Self {
            weapon_id: info.weapon_id,
            star_level: info.star_level,
            plus_marks: info.plus_marks,
            awakening_level: info.awakening_level,
            trait_1_id: info.trait_1_id,
            trait_1_level: info.trait_1_level,
            trait_2_id: info.trait_2_id,
            trait_2_level: info.trait_2_level,
            trait_3_id: info.trait_3_id,
            trait_3_level: info.trait_3_level,
            wrightstone_id: info.wrightstone_id,
            weapon_level: info.weapon_level,
            weapon_hp: info.weapon_hp,
            weapon_attack: info.weapon_attack,
        }
    }
}

/// Overmastery, also known as `limit_bonus`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Overmastery {
    /// Overmastery ID
    pub id: u32,
    /// Flags
    pub flags: u32,
    /// Value
    pub value: f32,
}

impl From<protocol::Overmastery> for Overmastery {
    fn from(info: protocol::Overmastery) -> Self {
        Self {
            id: info.id,
            flags: info.flags,
            value: info.value,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OvermasteryInfo {
    pub overmasteries: Vec<Overmastery>,
}

impl From<protocol::OvermasteryInfo> for OvermasteryInfo {
    fn from(info: protocol::OvermasteryInfo) -> Self {
        Self {
            overmasteries: info
                .overmasteries
                .into_iter()
                .map(Overmastery::from)
                .collect(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStats {
    pub level: u32,
    pub total_hp: u32,
    pub total_attack: u32,
    pub stun_power: f32,
    pub critical_rate: f32,
    pub total_power: u32,
}

impl From<protocol::PlayerStats> for PlayerStats {
    fn from(stats: protocol::PlayerStats) -> Self {
        Self {
            level: stats.level,
            total_hp: stats.total_hp,
            total_attack: stats.total_attack,
            stun_power: stats.stun_power,
            critical_rate: stats.critical_rate,
            total_power: stats.total_power,
        }
    }
}

/// Equippable sigil for a character
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Sigil {
    /// ID of the first trait in this sigil
    pub first_trait_id: u32,
    /// Level of the first trait in this sigil
    pub first_trait_level: u32,
    /// ID of the second trait in this sigil
    pub second_trait_id: u32,
    /// Level of the second trait in this sigil
    pub second_trait_level: u32,
    /// ID of the sigil
    pub sigil_id: u32,
    /// ID of the character that this sigil is equipped to
    pub equipped_character: u32,
    /// Level of the sigil
    pub sigil_level: u32,
    /// Acquisition count, at what sigil count this sigil was acquired
    pub acquisition_count: u32,
    /// 0 is new sigil and shows a (!), 1 is nothing, 2 is notification was checked and removes the (!)
    pub notification_enum: u32,
}

/// One equipped summon (v2.0.2 expansion: 4 account-level summons whose bonuses
/// apply party-wide). `summon_id` keys the summon table, `main_trait_id` is a
/// regular trait id (named by the `traits:` lang namespace), `bonus_id` keys the
/// summon base-param table; `bonus_level` is 0-indexed (max 9).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EquippedSummon {
    pub summon_id: u32,
    pub main_trait_id: u32,
    pub main_trait_level: u32,
    pub bonus_id: u32,
    pub bonus_level: u32,
}

impl From<protocol::EquippedSummon> for EquippedSummon {
    fn from(summon: protocol::EquippedSummon) -> Self {
        Self {
            summon_id: summon.summon_id,
            main_trait_id: summon.main_trait_id,
            main_trait_level: summon.main_trait_level,
            bonus_id: summon.bonus_id,
            bonus_level: summon.bonus_level,
        }
    }
}

/// The v2.0.2 record-inline stat block (identity-path recovery). Labels for
/// `hp`/`attack`/`stun_power`/`power` follow the pre-2.0 `PlayerStats` layout
/// the block mirrors; `unk_50` is the one still-unconfirmed slot.
///
/// `critical_rate` was stored as `unk_58: u32` before 2026-07-24, so logs older
/// than that carry `unk58` and no `criticalRate` and the field has to stay
/// optional or none of them load (see `stored_log_compat` below). Their old
/// value is not carried over, and the builds panel hides a zero crit rate.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordStats {
    pub level: u32,
    pub hp: u32,
    pub attack: u32,
    pub unk_50: u32,
    pub stun_power: f32,
    #[serde(default)]
    pub critical_rate: f32,
    pub power: u32,
}

impl From<protocol::RecordStats> for RecordStats {
    fn from(stats: protocol::RecordStats) -> Self {
        Self {
            level: stats.level,
            hp: stats.hp,
            attack: stats.attack,
            unk_50: stats.unk_50,
            stun_power: stats.stun_power,
            critical_rate: stats.critical_rate,
            power: stats.power,
        }
    }
}

/// One trait id/level pair (wrightstone or innate weapon skill).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WeaponTraitPair {
    pub id: u32,
    /// 0 when the level is not (yet) known.
    pub level: u32,
}

/// The equipped weapon's state (identity-path recovery, live-labeled
/// 2026-07-17). Every field is `#[serde(default)]` so logs stored by the
/// short-lived raw-block shape of this struct still deserialize (they carry
/// `weaponId` plus since-removed raw arrays, which serde ignores).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeaponState {
    #[serde(default)]
    pub weapon_id: u32,
    #[serde(default)]
    pub exp: u32,
    #[serde(default)]
    pub star_level: u32,
    #[serde(default)]
    pub plus_marks: u32,
    #[serde(default)]
    pub awakening_level: u32,
    #[serde(default)]
    pub wrightstone_id: u32,
    #[serde(default)]
    pub wrightstone_traits: Vec<WeaponTraitPair>,
    /// The ACTIVE innate skills (awakening/transcendence upgrades applied).
    #[serde(default)]
    pub innate_traits: Vec<WeaponTraitPair>,
}

impl From<protocol::WeaponState> for WeaponState {
    fn from(state: protocol::WeaponState) -> Self {
        let pairs = |v: Vec<protocol::WeaponTraitPair>| {
            v.into_iter()
                .map(|t| WeaponTraitPair {
                    id: t.id,
                    level: t.level,
                })
                .collect()
        };
        Self {
            weapon_id: state.weapon_id,
            exp: state.exp,
            star_level: state.star_level,
            plus_marks: state.plus_marks,
            awakening_level: state.awakening_level,
            wrightstone_id: state.wrightstone_id,
            wrightstone_traits: pairs(state.wrightstone_traits),
            innate_traits: pairs(state.innate_traits),
        }
    }
}

/// Folds a fresh weapon-state read into the already-known one for the same
/// player. Identity refreshes re-read the record repeatedly, and reads of
/// REMOTE players are often partial (the wrightstone item id never syncs, and
/// awakening / innate skills can read empty before the network sync lands) —
/// so a later sparse read must not wipe fields an earlier read recovered.
/// A different weapon id replaces the state wholesale (a real re-equip in the
/// lobby); the same weapon id keeps the best-known value per field. The
/// progression fields use max() because they only ever grow while equipped and
/// the hook's sanity clamp turns garbage into 0.
fn merge_weapon_state(known: WeaponState, fresh: WeaponState) -> WeaponState {
    if fresh.weapon_id != known.weapon_id {
        return fresh;
    }
    // Non-empty beats empty, leveled beats unleveled; ties keep the fresh read.
    let pick = |known: Vec<WeaponTraitPair>, fresh: Vec<WeaponTraitPair>| {
        let score =
            |t: &[WeaponTraitPair]| (!t.is_empty() as u8, t.iter().any(|p| p.level > 0) as u8);
        if score(&fresh) >= score(&known) {
            fresh
        } else {
            known
        }
    };
    WeaponState {
        weapon_id: fresh.weapon_id,
        exp: known.exp.max(fresh.exp),
        star_level: known.star_level.max(fresh.star_level),
        plus_marks: known.plus_marks.max(fresh.plus_marks),
        awakening_level: known.awakening_level.max(fresh.awakening_level),
        wrightstone_id: if fresh.wrightstone_id != 0 {
            fresh.wrightstone_id
        } else {
            known.wrightstone_id
        },
        wrightstone_traits: pick(known.wrightstone_traits, fresh.wrightstone_traits),
        innate_traits: pick(known.innate_traits, fresh.innate_traits),
    }
}

/// Data for a player in the encounter
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerData {
    /// Actor index for this player
    actor_index: u32,
    /// Display name for this player, empty if its an NPC
    display_name: String,
    /// Character name for this player if it's an NPC, otherwise it is the same as display_name
    character_name: String,
    /// Character type for this player
    character_type: CharacterType,
    /// Sigils that this player has equipped
    sigils: Vec<Sigil>,
    /// The 4 equipped summons (account-level, party-wide bonuses). Empty on logs
    /// recorded before summon recovery shipped; `#[serde(default)]` keeps those
    /// stored logs readable.
    #[serde(default)]
    summons: Vec<EquippedSummon>,
    /// The 4 equipped ability (skill) ids (`AB_PL####_##` hashes). Empty on
    /// logs recorded before ability recovery shipped; `#[serde(default)]`
    /// keeps those stored logs readable.
    #[serde(default)]
    abilities: Vec<u32>,
    /// Equipped weapon as its full game key name (e.g. `WEP_PL2700_02_01`).
    /// Empty when unresolved; `#[serde(default)]` keeps stored logs readable.
    #[serde(default)]
    weapon_key: String,
    /// Master level, level+stars combined as the game stores it (55 = 50 + 5
    /// stars). 0 when unknown; `#[serde(default)]` keeps stored logs readable.
    #[serde(default)]
    master_level: u32,
    /// Unlocked skillboard (master trait) node effect ids. Empty on logs
    /// recorded before skillboard recovery shipped; `#[serde(default)]` keeps
    /// those stored logs readable.
    #[serde(default)]
    skillboard: Vec<u32>,
    /// The record-inline stat block (v2.0.2 identity-path recovery). `None` on
    /// logs recorded before it shipped; `#[serde(default)]` keeps them readable.
    #[serde(default)]
    stats: Option<RecordStats>,
    /// The equipped weapon's save-row snapshot (v2.0.2 identity-path recovery).
    /// `None` on logs recorded before it shipped; `#[serde(default)]` keeps
    /// them readable.
    #[serde(default)]
    weapon_state: Option<WeaponState>,
    /// The game's own damage-cap-up total for this player, per attack class
    /// (Normal / Skill / Skybound Art), already in the units the cap formula
    /// adds. The game sums every sigil, trait, node and bonus into these before
    /// the hook ever sees them, so they are the TOTAL a derived breakdown is
    /// reconciled against — not a decomposition. `None` on logs recorded before
    /// the capture shipped; `#[serde(default)]` keeps those readable.
    #[serde(default)]
    cap_up_normal: Option<f32>,
    #[serde(default)]
    cap_up_skill: Option<f32>,
    #[serde(default)]
    cap_up_sba: Option<f32>,
    /// Whether this player was an online player or not
    is_online: bool,
    /// Weapon info for this player
    weapon_info: Option<WeaponInfo>,
    /// Overmastery info for this player
    overmastery_info: Option<OvermasteryInfo>,
    /// Player stats for this player
    player_stats: Option<PlayerStats>,
}

/// Hand-written rather than derived because `CharacterType` has no `Default`
/// and giving it one would assert a default character for the whole crate.
/// An unknown hash is the honest stand-in for "no character read yet".
impl Default for PlayerData {
    fn default() -> Self {
        Self {
            actor_index: 0,
            display_name: String::new(),
            character_name: String::new(),
            character_type: CharacterType::Unknown(0),
            sigils: Vec::new(),
            summons: Vec::new(),
            abilities: Vec::new(),
            weapon_key: String::new(),
            master_level: 0,
            skillboard: Vec::new(),
            stats: None,
            weapon_state: None,
            cap_up_normal: None,
            cap_up_skill: None,
            cap_up_sba: None,
            is_online: false,
            weapon_info: None,
            overmastery_info: None,
            player_stats: None,
        }
    }
}

/// Owned `protocol`-typed copies of the fields the legality rules read.
///
/// The rules are written against `protocol` types so they stay independent of
/// this module's persisted on-disk format, but `PlayerData` stores the parser's
/// own mirrors of those types. The struct itself lives with the rules that read
/// it; the `From` impls below and [`PlayerData::legality_inputs`] are the bridge.
pub use crate::legality::LegalityInputs;

impl From<&WeaponTraitPair> for protocol::WeaponTraitPair {
    fn from(pair: &WeaponTraitPair) -> Self {
        Self {
            id: pair.id,
            level: pair.level,
        }
    }
}

impl From<&Overmastery> for protocol::Overmastery {
    fn from(mastery: &Overmastery) -> Self {
        Self {
            id: mastery.id,
            flags: mastery.flags,
            value: mastery.value,
        }
    }
}

impl From<&Sigil> for protocol::Sigil {
    fn from(sigil: &Sigil) -> Self {
        Self {
            first_trait_id: sigil.first_trait_id,
            first_trait_level: sigil.first_trait_level,
            second_trait_id: sigil.second_trait_id,
            second_trait_level: sigil.second_trait_level,
            sigil_id: sigil.sigil_id,
            equipped_character: sigil.equipped_character,
            sigil_level: sigil.sigil_level,
            acquisition_count: sigil.acquisition_count,
            notification_enum: sigil.notification_enum,
        }
    }
}

impl From<&EquippedSummon> for protocol::EquippedSummon {
    fn from(summon: &EquippedSummon) -> Self {
        Self {
            summon_id: summon.summon_id,
            main_trait_id: summon.main_trait_id,
            main_trait_level: summon.main_trait_level,
            bonus_id: summon.bonus_id,
            bonus_level: summon.bonus_level,
        }
    }
}

impl From<&WeaponState> for protocol::WeaponState {
    fn from(state: &WeaponState) -> Self {
        Self {
            weapon_id: state.weapon_id,
            exp: state.exp,
            star_level: state.star_level,
            plus_marks: state.plus_marks,
            awakening_level: state.awakening_level,
            wrightstone_id: state.wrightstone_id,
            wrightstone_traits: state.wrightstone_traits.iter().map(Into::into).collect(),
            innate_traits: state.innate_traits.iter().map(Into::into).collect(),
        }
    }
}

impl From<&OvermasteryInfo> for protocol::OvermasteryInfo {
    fn from(info: &OvermasteryInfo) -> Self {
        Self {
            overmasteries: info.overmasteries.iter().map(Into::into).collect(),
        }
    }
}

impl PlayerData {
    /// Convert the fields the legality rules need into `protocol` types. Lives
    /// here because `PlayerData`'s fields are private to this module.
    pub fn legality_inputs(&self) -> LegalityInputs {
        LegalityInputs {
            sigils: self.sigils.iter().map(Into::into).collect(),
            summons: self.summons.iter().map(Into::into).collect(),
            weapon_state: self.weapon_state.as_ref().map(Into::into),
            overmastery_info: self.overmastery_info.as_ref().map(Into::into),
            skillboard: self.skillboard.clone(),
        }
    }

    /// Who this row is, for a caller that has to label an audited player.
    /// Here for the same reason `legality_inputs` is: the fields are private to
    /// this module, and the serde shape is a storage format, not an API.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// True when this slot names somebody — what the quest list's party column
    /// and the player filters display.
    pub fn has_identity(&self) -> bool {
        !self.display_name.is_empty() || !self.character_name.is_empty()
    }

    /// True when this slot carries any recovered build data — anything the log
    /// page's equipment panes and the cheat audit read.
    pub fn has_equipment(&self) -> bool {
        !self.sigils.is_empty()
            || !self.summons.is_empty()
            || !self.abilities.is_empty()
            || !self.skillboard.is_empty()
            || self.stats.is_some()
            || self.weapon_state.is_some()
            || self.weapon_info.is_some()
            || self.overmastery_info.is_some()
            || self.player_stats.is_some()
    }

    pub fn character_name(&self) -> &str {
        &self.character_name
    }

    pub fn character_type(&self) -> CharacterType {
        self.character_type
    }
}

/// Derived breakdown for an enemy target
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnemyState {
    index: u32,
    target_type: EnemyType,
    raw_target_type: u32,
    total_damage: u64,
    /// Post-hit remaining HP of the largest pool seen under this key. Multi-part
    /// bosses report per-part pools against the same parent index, so smaller
    /// pools never clobber the main body's. `None` on old logs / failed reads.
    #[serde(default)]
    current_hp: Option<u64>,
    /// Maximum HP of that same pool.
    #[serde(default)]
    max_hp: Option<u64>,
}

impl EnemyState {
    fn update_from_damage_event(&mut self, damage_instance: &AdjustedDamageInstance) {
        self.total_damage += damage_instance.event.damage as u64;

        if let (Some(current), Some(max)) = (
            damage_instance.event.target_current_hp,
            damage_instance.event.target_max_hp,
        ) {
            // Track the largest pool under this key; same-pool reports refresh
            // current, smaller pools (other parts) are ignored.
            //
            // ...EXCEPT once the tracked pool is dead. This key is the game's actor
            // index, which is reused across boss phases and summon waves, so latching
            // on "largest ever seen" left a killed 50m phase-1 pool pinned at 0% while
            // a live 30m phase-2 pool was being hit — every later report failed
            // `max >= known` and could never take over. A different pool arriving after
            // the tracked one hit zero replaces it outright.
            let tracked_pool_is_dead = self.current_hp == Some(0);
            let is_a_different_pool = self.max_hp.is_some_and(|known| known != max);
            if self.max_hp.map_or(true, |known| max >= known)
                || (tracked_pool_is_dead && is_a_different_pool)
            {
                self.current_hp = Some(current);
                self.max_hp = Some(max);
            }
        }
    }
}

/// The necessary details of an encounter that can be used to recreate the state at any point in time.
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Encounter {
    pub player_data: [Option<PlayerData>; 4],
    pub quest_id: Option<u32>,
    pub quest_timer: Option<u32>,
    #[serde(default)]
    pub quest_completed: bool,

    /// DEPRECATED: Use `self.event_log()` instead.
    pub event_log: Vec<(i64, DamageEvent)>,

    #[serde(default)]
    pub raw_event_log: Vec<(i64, Message)>,
}

/// The stored-log encoding: CBOR, then zstd. The one place the on-disk format
/// is defined, so a test can write a blob in an OLD struct shape and still be
/// exercising today's real framing (see `stored_log_compat`).
fn to_stored_blob<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let cbor = cbor4ii::serde::to_vec(Vec::new(), value)?;
    Ok(zstd::encode_all(cbor.as_slice(), 3)?)
}

impl Encounter {
    /// Compresses this encounter data into a binary blob.
    pub fn to_blob(&self) -> Result<Vec<u8>> {
        to_stored_blob(self)
    }

    /// Audits every occupied party slot and stores the verdicts against
    /// `log_id`. Clean players write nothing — a slot with no row reads as
    /// clean, so storing empty verdicts would only cost space.
    ///
    /// The save path and the startup sweep are the two callers, and they must
    /// agree on what a stored row carries; keeping the walk here means a change
    /// to that reaches both.
    ///
    /// APPENDS. `log_id` must carry no findings yet — a freshly inserted log, or
    /// one the caller has just passed to [`crate::db::legality::clear_findings`]
    /// (which is what the sweep does). Re-running this over a log that already
    /// has rows stores every verdict twice, and nothing downstream deduplicates.
    pub fn write_legality_findings(&self, conn: &Connection, log_id: i64) -> Result<()> {
        for (player_index, player) in self.player_data.iter().enumerate() {
            let Some(player) = player else { continue };
            let findings = crate::legality::audit_player(player);
            if findings.is_empty() {
                continue;
            }
            crate::db::legality::write_findings(
                conn,
                log_id,
                player_index,
                player.display_name(),
                &player.character_type().to_string(),
                &findings,
            )?;
        }
        Ok(())
    }

    /// Deserializes a binary blob into encounter instance.
    pub fn from_blob(blob: &[u8]) -> Result<Self> {
        let decompressed = zstd::decode_all(blob)?;
        Ok(cbor4ii::serde::from_slice(&decompressed)?)
    }

    /// For older logs that don't have the event log, we need to repopulate it.
    pub fn repopulate_event_log(&mut self) {
        if !self.raw_event_log.is_empty() {
            return;
        }

        for (timestamp, event) in self.event_log.iter() {
            self.raw_event_log
                .push((*timestamp, Message::DamageEvent(event.clone())));
        }
    }

    fn reset_player_data(&mut self) {
        self.player_data[0..=3].clone_from_slice(&[None, None, None, None]);
    }

    fn reset_quest(&mut self) {
        self.quest_id = None;
        self.quest_timer = None;
    }

    fn push_event(&mut self, timestamp: i64, event: protocol::Message) {
        self.raw_event_log.push((timestamp, event));
    }

    pub fn event_log(&self) -> impl Iterator<Item = &(i64, Message)> {
        self.raw_event_log.iter()
    }

    /// Which kinds of data this encounter actually carries. Drives the import
    /// dialog's per-category availability report: a logs.db recorded by an
    /// older or third-party build can lack whole classes of events, and the
    /// only way to know is to look. Call after [`Self::repopulate_event_log`]
    /// (as [`Parser::from_encounter_blob`] does) so legacy logs report their
    /// damage-carried fields too.
    pub fn data_coverage(&self) -> DataCoverage {
        let mut coverage = DataCoverage {
            party_names: self
                .player_data
                .iter()
                .flatten()
                .any(PlayerData::has_identity),
            equipment: self
                .player_data
                .iter()
                .flatten()
                .any(PlayerData::has_equipment),
            quest: self.quest_id.is_some(),
            quest_time: self.quest_timer.is_some(),
            ..Default::default()
        };

        for (_, message) in self.event_log() {
            match message {
                Message::DamageEvent(event) => {
                    // An incoming hit's HP pair is the PLAYER's pool, not
                    // enemy-HP coverage.
                    if !is_damage_taken_event(event) {
                        coverage.enemy_hp |= event.target_current_hp.is_some();
                        coverage.overcap |= event.base_damage.is_some();
                    }
                }
                Message::OnDeathEvent(_) => coverage.deaths = true,
                Message::OnPlayerStun(_)
                | Message::OnPerfectGuardStun(_)
                | Message::OnPerfectGuardQuickening(_)
                | Message::OnStunEffect(_) => coverage.stun_events = true,
                Message::OnUpdateSBA(_)
                | Message::OnAttemptSBA(_)
                | Message::OnPerformSBA(_)
                | Message::OnContinueSBAChain(_) => coverage.sba_events = true,
                _ => {}
            }
            // Every event-derived flag is already true — the rest of a long
            // fight's log has nothing left to prove.
            if coverage.enemy_hp
                && coverage.overcap
                && coverage.deaths
                && coverage.stun_events
                && coverage.sba_events
            {
                break;
            }
        }

        coverage
    }

    /// The party's character types as the damage events tell them: one entry
    /// per distinct source parent that maps to a known character, in
    /// first-hit order, capped at the four party slots. This is the same
    /// derivation the meter's rows are built from (see `ensure_player_row`),
    /// so the import backfill can fill the quest list's character columns for
    /// logs whose source never recorded player identity. Display names are
    /// not recoverable — nothing in a damage event carries them.
    pub fn derive_party_characters(&self) -> Vec<CharacterType> {
        let mut seen_parents = Vec::new();
        let mut characters = Vec::new();
        for (_, message) in self.event_log() {
            let Message::DamageEvent(event) = message else {
                continue;
            };
            let character = CharacterType::from_hash(event.source.parent_actor_type);
            if matches!(character, CharacterType::Unknown(_))
                || seen_parents.contains(&event.source.parent_index)
            {
                continue;
            }
            seen_parents.push(event.source.parent_index);
            characters.push(character);
            if characters.len() == 4 {
                break;
            }
        }
        characters
    }
}

/// See [`Encounter::data_coverage`]. One flag per category the import dialog
/// reports on; `false` means "this encounter carries none of it".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DataCoverage {
    pub party_names: bool,
    pub equipment: bool,
    pub enemy_hp: bool,
    pub overcap: bool,
    pub deaths: bool,
    pub stun_events: bool,
    pub sba_events: bool,
    /// A quest id (and with it a meaningful clear status) was recorded.
    pub quest: bool,
    pub quest_time: bool,
}

#[cfg(test)]
mod data_coverage_tests {
    use super::*;

    fn actor() -> protocol::Actor {
        protocol::Actor {
            index: 0,
            actor_type: 0,
            parent_index: 0,
            parent_actor_type: 0,
        }
    }

    fn damage(base_damage: Option<f32>, target_hp: Option<u64>) -> Message {
        Message::DamageEvent(protocol::DamageEvent {
            source: actor(),
            target: actor(),
            damage: 100,
            flags: 0,
            action_id: protocol::ActionType::Normal(1),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage,
            target_current_hp: target_hp,
            target_max_hp: target_hp,
            class_flags: None,
        })
    }

    #[test]
    fn an_empty_encounter_covers_nothing() {
        assert_eq!(
            Encounter::default().data_coverage(),
            DataCoverage::default()
        );
    }

    /// The shape of a log recorded by a build without HP capture, overcap,
    /// deaths, stun, or SBA hooks: damage alone lights no optional category.
    #[test]
    fn bare_damage_events_light_no_optional_category() {
        let encounter = Encounter {
            raw_event_log: vec![(0, damage(None, None))],
            ..Default::default()
        };

        assert_eq!(encounter.data_coverage(), DataCoverage::default());
    }

    #[test]
    fn each_kind_of_data_lights_its_own_category() {
        let encounter = Encounter {
            player_data: [
                Some(PlayerData {
                    display_name: "Kahs".into(),
                    overmastery_info: Some(OvermasteryInfo {
                        overmasteries: Vec::new(),
                    }),
                    ..Default::default()
                }),
                None,
                None,
                None,
            ],
            quest_id: Some(77),
            quest_timer: Some(120),
            raw_event_log: vec![
                (0, damage(Some(123.0), Some(1_000_000))),
                (
                    1,
                    Message::OnDeathEvent(protocol::OnDeathEvent {
                        actor_index: 0,
                        death_counter: 1,
                    }),
                ),
                (
                    2,
                    Message::OnUpdateSBA(protocol::OnUpdateSBAEvent {
                        actor_index: 0,
                        sba_value: 10.0,
                        sba_added: 1.0,
                    }),
                ),
                (
                    3,
                    Message::OnPlayerStun(protocol::OnPlayerStunEvent {
                        actor_index: 0,
                        stun_amount: 5.0,
                    }),
                ),
            ],
            ..Default::default()
        };

        assert_eq!(
            encounter.data_coverage(),
            DataCoverage {
                party_names: true,
                equipment: true,
                enemy_hp: true,
                overcap: true,
                deaths: true,
                stun_events: true,
                sba_events: true,
                quest: true,
                quest_time: true,
            }
        );
    }

    /// Party characters come from damage-event source parents: known player
    /// hashes in first-hit order, one per parent index, enemies (unknown
    /// hashes) skipped, duplicates collapsed.
    #[test]
    fn party_characters_derive_from_damage_sources_in_first_hit_order() {
        let player = |parent_index: u32, hash: u32| {
            let mut event = match damage(None, None) {
                Message::DamageEvent(event) => event,
                _ => unreachable!(),
            };
            event.source.parent_index = parent_index;
            event.source.parent_actor_type = hash;
            Message::DamageEvent(event)
        };
        let encounter = Encounter {
            raw_event_log: vec![
                (0, player(2, 0x601AA977)), // Pl1400
                (1, player(9, 0xDEADBEEF)), // an enemy: unknown hash, skipped
                (2, player(2, 0x601AA977)), // same parent again: collapsed
                (3, player(5, 0x28AC1108)), // Pl1000
            ],
            ..Default::default()
        };

        assert_eq!(
            encounter.derive_party_characters(),
            vec![CharacterType::Pl1400, CharacterType::Pl1000]
        );
    }

    /// An occupied slot with no name and no gear (the pre-identity-capture
    /// shape) counts for neither party names nor equipment.
    #[test]
    fn a_nameless_bare_slot_counts_for_nothing() {
        let encounter = Encounter {
            player_data: [Some(PlayerData::default()), None, None, None],
            ..Default::default()
        };

        let coverage = encounter.data_coverage();
        assert!(!coverage.party_names);
        assert!(!coverage.equipment);
    }
}

/// The status of the parser.
#[derive(Debug, Serialize, Deserialize, Default, PartialEq, PartialOrd, Clone, Copy)]
enum ParserStatus {
    InProgress,
    #[default]
    Stopped,
}

/// The state of the encounter after processing all damage events (or all known events for now)
/// Used for parsing the encounter into a calculated format that can be consumed by the front-end.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedEncounterState {
    /// Timestamp of the first damage event
    start_time: i64,
    /// Timestamp of the last damage event (or the last known damage event if the encounter is still in progress)
    end_time: i64,
    /// True once the DPS window has been anchored, either by the encounter's
    /// first counted damage event or by an explicit scrub window. Guards and
    /// stun procs open an encounter but must not anchor it — see
    /// [`Self::extend_window`].
    #[serde(skip)]
    window_anchored: bool,
    /// The total damage done in the encounter
    total_damage: u64,
    /// The total DPS done in the encounter
    dps: f64,
    /// The total stun value done in the encounter
    total_stun_value: f64,
    /// The total stun value per second done in the encounter
    stun_per_second: f64,
    /// Encounter-wide stun via accumulator deltas (solo path; 0 online).
    #[serde(default)]
    stun_delta_sum: f64,
    /// Encounter-wide stun via network stun messages (online path; may also
    /// fire solo, where it duplicates the delta path — `total_stun_value` is
    /// max(delta, messages) so the paths can never double-count).
    #[serde(default)]
    stun_message_sum: f64,
    /// Stun messages that arrived before the player's first damage event
    /// created their party row; folded in on row creation.
    #[serde(skip)]
    pending_player_stun: HashMap<u32, f64>,
    /// Perfect Guard stun that arrived before the guarding player's first
    /// damage event; folded into their DELTA sum on row creation. One entry per
    /// guard so the breakdown row's guard count and per-guard max survive.
    #[serde(skip)]
    pending_player_pg_stun: HashMap<u32, Vec<f64>>,
    /// Guarded-Quickening guard counts that arrived before the guarding
    /// player's first damage event; folded into their hits-only row on row
    /// creation.
    #[serde(skip)]
    pending_player_pg_quickening: HashMap<u32, u32>,
    /// Non-guard stun-effect procs (Eugen's sticky grenade) that arrived before
    /// the applying player's first damage event; folded into their StunEffect row
    /// on row creation. One entry per proc so the row's hit count and per-proc max
    /// survive.
    #[serde(skip)]
    pending_player_stun_effect: HashMap<u32, Vec<f64>>,
    /// Non-skill gauge causes seen before their player's row existed, held by
    /// slot key. Quest-start gauge genuinely arrives before anyone has dealt
    /// damage, so dropping it would lose a real, nameable chunk of the bar.
    #[serde(skip)]
    pending_player_sba_sources: HashMap<u32, Vec<(SbaSourceKind, Option<u32>, f64)>>,
    /// Gauge polls and forced levels seen before their player's row existed:
    /// the last known level, plus every poll's positive `added` summed. Held
    /// because SBA is a property of the player, not of any hit — and under a
    /// source pin the damage events that would create the OTHER players' rows
    /// are filtered out entirely, so dropping these made pinning one player
    /// change everyone else's gauge figures.
    #[serde(skip)]
    pending_player_sba: HashMap<u32, (f64, f64)>,
    /// Skill-cause gauge gains seen before their player's row existed. Folded
    /// through [`PlayerState::add_sba_gain`] on row creation, so they land on
    /// (or keep waiting for) the causing skill's own row — never inventing a
    /// player from a gain alone.
    #[serde(skip)]
    pending_player_sba_gains: HashMap<u32, Vec<(ActionType, f64)>>,
    /// Incoming (enemy→party) hits that landed on a slot with no identity yet;
    /// folded into the victim's row on creation. Whole events rather than the
    /// three fields the fold reads, so [`PlayerState::add_damage_taken`] stays
    /// the single authority on how a taken hit is filed.
    #[serde(skip)]
    pending_player_taken: HashMap<u32, Vec<DamageEvent>>,
    /// Players whose most recent stun-capable hit was filtered out of the meters
    /// (see [`is_excluded`]).
    ///
    /// A network stun message carries no action id, so it is attributed to the
    /// player's last stun-capable skill. That makes dropping the damage of an
    /// excluded hit insufficient online: its message would survive, keep its
    /// stun in the totals, and be credited to whichever skill came BEFORE the
    /// excluded one. Set on an excluded hit and cleared by the next counted one,
    /// mirroring the attribution it shadows.
    #[serde(skip)]
    stun_suppressed_players: HashSet<u32>,
    /// Status of the parser
    status: ParserStatus,
    /// Derived party stats
    pub party: HashMap<u32, PlayerState>,
    /// Derived target stats, damage done to each target.
    targets: HashMap<u32, EnemyState>,
}

impl Default for DerivedEncounterState {
    fn default() -> Self {
        Self {
            start_time: 0,
            end_time: 0,
            window_anchored: false,
            total_damage: 0,
            dps: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            stun_delta_sum: 0.0,
            stun_message_sum: 0.0,
            pending_player_stun: HashMap::new(),
            pending_player_pg_stun: HashMap::new(),
            pending_player_pg_quickening: HashMap::new(),
            pending_player_stun_effect: HashMap::new(),
            pending_player_sba_sources: HashMap::new(),
            pending_player_sba: HashMap::new(),
            pending_player_sba_gains: HashMap::new(),
            pending_player_taken: HashMap::new(),
            stun_suppressed_players: HashSet::new(),
            status: ParserStatus::Stopped,
            party: HashMap::new(),
            targets: HashMap::new(),
        }
    }
}

impl DerivedEncounterState {
    pub fn duration(&self) -> i64 {
        (self.end_time - self.start_time).max(1)
    }

    fn duration_secs(&self) -> f64 {
        self.duration() as f64 / 1000.0
    }

    fn utc_start_time(&self) -> Result<chrono::DateTime<Utc>> {
        chrono::DateTime::from_timestamp_millis(self.start_time)
            .ok_or(anyhow::anyhow!("Failed to convert start time to DateTime"))
    }

    fn start(&mut self, now: i64) {
        self.start_time = now;
        self.end_time = now;
    }

    /// Opens the window at an explicitly chosen point (the logs-page scrubber)
    /// so [`Self::extend_window`] leaves its start alone — the user picked that
    /// range and the first hit inside it must not override them.
    fn start_pinned(&mut self, now: i64) {
        self.start(now);
        self.window_anchored = true;
    }

    /// Extends the DPS window to `now`, opening it if this is the encounter's
    /// first damage.
    ///
    /// **Only damage moves this window.** A Perfect Guard, a stun proc or a
    /// Quickening guard can open an *encounter* — they are real events and
    /// belong in the log (see `ensure_encounter_started`) — but they are not
    /// damage, and dividing a fight's damage by time in which nobody attacked
    /// understates DPS. A fight that opens with a long defensive phase
    /// (Lucilius' Paradise Lost is ~30s of it) would otherwise be measured over
    /// a window that began before the first hit, and a guard landing after the
    /// boss dies would stretch it at the other end.
    fn extend_window(&mut self, now: i64) {
        if !self.window_anchored {
            self.window_anchored = true;
            self.start_time = now;
        }
        self.end_time = now;
    }

    /// Accumulates an incoming (enemy→party) hit onto the victim's row. Never
    /// touches the DPS window: taken damage opens an encounter (the live
    /// path's `ensure_encounter_started` has already run) but the window is
    /// anchored and stretched only by dealt hits — same posture as guards and
    /// stun procs.
    ///
    /// It shares their row-creation rule too, and for a reason that is not about
    /// this metric: the overlay names a row by joining its slot key against
    /// `player_data`, which is filled only by the identity the hook publishes
    /// with a DEALT hit. Opening a row from an incoming hit alone therefore drew
    /// a bar with an icon and no name — the first thing a fight does is hit the
    /// party, so this was the common case, not the corner one. The hit is held
    /// against the slot instead and folded in whole when the row appears.
    ///
    /// The gate is on the IDENTITY, not on the row: once a row exists it
    /// accumulates whether or not the slot was ever identified, so a log whose
    /// party never resolved still reports what its rows took.
    fn process_damage_taken_event(
        &mut self,
        player_data: &[Option<PlayerData>; 4],
        event: &DamageEvent,
    ) {
        let victim_slot = event.target.parent_index;

        if character_type_for_slot_key(player_data, victim_slot).is_some() {
            // The row keeps the class the EVENT reports, like the dealt path —
            // the identity is only what says the row can be named.
            self.ensure_player_row(
                victim_slot,
                CharacterType::from_hash(event.target.parent_actor_type),
            );
        }

        match self.party.get_mut(&victim_slot) {
            Some(victim) => victim.add_damage_taken(event),
            None => self
                .pending_player_taken
                .entry(victim_slot)
                .or_default()
                .push(event.clone()),
        }
    }

    /// `total_stun_value` = whichever capture path saw the accrual (the two
    /// paths observe the same accumulator, so max() dedupes them — the
    /// encounter-level mirror of `PlayerState::refresh_total_stun`).
    fn refresh_total_stun(&mut self) {
        self.total_stun_value = self.stun_delta_sum.max(self.stun_message_sum);
    }

    /// Gets the primary target of the encounter (the target that had the most damage done to it)
    fn get_primary_target(&self) -> Option<&EnemyState> {
        self.targets
            .values()
            .max_by_key(|target| target.total_damage)
    }

    /// Records that a filtered-out hit landed, so the network stun message
    /// trailing it is dropped instead of being credited to the previous skill.
    ///
    /// Mirrors the attribution rule in `PlayerState::update_from_damage_event`:
    /// echoes and DoT ticks cannot proc stun, so they never own a message and
    /// must not shadow the hit that does.
    fn note_excluded_damage(&mut self, event: &DamageEvent) {
        if matches!(
            event.action_id,
            ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
        ) {
            return;
        }

        self.stun_suppressed_players
            .insert(event.source.parent_index);
    }

    fn process_damage_event(&mut self, now: i64, damage_instance: &AdjustedDamageInstance) {
        self.extend_window(now);
        self.total_damage += damage_instance.event.damage as u64;
        self.dps = self.total_damage as f64 / self.duration_secs();

        // Update stun value (delta path; see refresh_total_stun for the dedupe rule).
        self.stun_delta_sum += damage_instance.stun_damage;
        self.refresh_total_stun();
        self.stun_per_second = self.total_stun_value / self.duration_secs();

        // Add actor to party if not already present (folding in any stun/guard
        // state held pending for the slot).
        self.ensure_player_row(
            damage_instance.event.source.parent_index,
            CharacterType::from_hash(damage_instance.event.source.parent_actor_type),
        );
        let source_player = self
            .party
            .get_mut(&damage_instance.event.source.parent_index)
            .expect("ensure_player_row created the row above");

        // Update player stats from damage event.
        source_player.update_from_damage_event(damage_instance);

        // A counted stun-capable hit takes ownership of the next message back
        // from any excluded hit before it (see `note_excluded_damage`).
        if !matches!(
            damage_instance.event.action_id,
            ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
        ) {
            self.stun_suppressed_players
                .remove(&damage_instance.event.source.parent_index);
        }

        // Update target stats from damage event.
        let target = self
            .targets
            .entry(damage_instance.event.target.parent_index)
            .or_insert(EnemyState {
                index: damage_instance.event.target.parent_index,
                target_type: EnemyType::from_hash(damage_instance.event.target.parent_actor_type),
                raw_target_type: damage_instance.event.target.parent_actor_type,
                total_damage: 0,
                current_hp: None,
                max_hp: None,
            });

        target.update_from_damage_event(damage_instance);

        // Update everyone's DPS
        let duration_secs = self.duration_secs();
        for player in self.party.values_mut() {
            player.update_rates(duration_secs);
        }
    }

    /// Folds one network stun-apply message (`OnPlayerStun`) into the encounter.
    /// This is the ONLINE stun source — the accumulator-delta path reads 0 there
    /// because enemy stun is host-authoritative and lands asynchronously.
    /// Totals are max(delta, messages) at both encounter and player level, so a
    /// mode where both paths fire (solo loopback) can never double-count.
    fn process_stun_message(&mut self, timestamp: i64, actor_index: u32, amount: f64) {
        // This message belongs to a hit the meters are not counting, so it is
        // dropped outright rather than attributed to the skill before it.
        if self.stun_suppressed_players.contains(&actor_index) {
            return;
        }

        self.stun_message_sum += amount;
        self.refresh_total_stun();
        let duration_secs = self.duration_secs();
        self.stun_per_second = self.total_stun_value / duration_secs;

        if let Some(player) = self.party.get_mut(&actor_index) {
            player.add_stun_message(timestamp, amount);
            player.stun_per_second = player.total_stun_value / duration_secs;
        } else {
            // Player row not created yet (no damage event seen); hold the stun
            // until their first damage event creates it.
            *self.pending_player_stun.entry(actor_index).or_insert(0.0) += amount;
        }
    }

    /// Folds one gauge reading into a player's row during a reparse.
    ///
    /// Silently skipped when the player has no row yet: unlike stun there is
    /// nothing to hold pending, because the gauge is a LEVEL — a later event
    /// carries the running total again, so an early reading lost before the
    /// player's first damage event costs at most its own `added`.
    fn process_sba_update(&mut self, actor_index: u32, value: f64, added: f64) {
        match self.party.get_mut(&actor_index) {
            Some(player) => player.apply_sba(value, added),
            // No row yet: hold the level and the rise until one is created
            // (see `pending_player_sba`).
            None => {
                let pending = self.pending_player_sba.entry(actor_index).or_default();
                pending.0 = value;
                pending.1 += added.max(0.0);
            }
        }
    }

    /// Files one attributed gauge gain against whatever its cause names.
    ///
    /// `Skill` goes to the breakdown row the causing hit opened, through the
    /// raw-action memo (see [`PlayerState::add_sba_gain`]). Every other cause is
    /// gauge no hit produced and goes to the player's source list — a cause must
    /// never be able to open a breakdown row, because a row with no hits is a
    /// row the damage and stun tables would have to show.
    ///
    /// NOTE the wire ordering — or rather, the absence of one. The hook emits a
    /// gain from the game's gauge-update path, which is entered through a
    /// separate register-hit gate and not necessarily on the thread the damage
    /// path runs on, so a `SbaGain` and the `DamageEvent` for the same hit can
    /// interleave arbitrarily at the shared `Tx`. A SKILL gain whose player has
    /// no party row yet is therefore dropped (fail-closed: inventing a player
    /// from a gain alone would put a damage-less row in the meter), while one
    /// whose skill merely has no row yet is held — see
    /// [`PlayerState::add_sba_gain`].
    fn process_sba_gain(&mut self, actor_index: u32, cause: protocol::SbaGainCause, amount: f64) {
        use protocol::SbaGainCause;

        let (kind, id) = match cause {
            SbaGainCause::Skill(action) => {
                match self.party.get_mut(&actor_index) {
                    Some(player) => player.add_sba_gain(action, amount),
                    // Held rather than dropped (see `pending_player_sba_gains`):
                    // the fold routes through `add_sba_gain`, so it still cannot
                    // invent a player or a damage-less row.
                    None => self
                        .pending_player_sba_gains
                        .entry(actor_index)
                        .or_default()
                        .push((action, amount)),
                }
                return;
            }
            SbaGainCause::DamageTaken => (SbaSourceKind::DamageTaken, None),
            SbaGainCause::PerfectGuard => (SbaSourceKind::PerfectGuard, None),
            SbaGainCause::Effect(id) => (SbaSourceKind::Effect, Some(id)),
            SbaGainCause::PartyAward => (SbaSourceKind::PartyAward, None),
            SbaGainCause::DirectorAward => (SbaSourceKind::DirectorAward, None),
            SbaGainCause::QuestStart => (SbaSourceKind::QuestStart, None),
            SbaGainCause::PerfectDodge => (SbaSourceKind::PerfectDodge, None),
            SbaGainCause::Site(tag) => (SbaSourceKind::Site, Some(tag)),
            SbaGainCause::Unknown => (SbaSourceKind::Unknown, None),
            // Deduced causes (see `sba_inference`). A move verdict routes to
            // the same breakdown row a read `Skill` would — it is keyed off a
            // hit that exists — but through `add_inferred_sba_gain`, which
            // tallies it separately so the UI can always say how much of a row
            // is measured and how much is concluded.
            SbaGainCause::Inferred(action) => {
                // Dropped rather than held when the player has no row: unlike a
                // read gain, this arrives after the whole log has been folded,
                // so a missing row means no hit of theirs was ever counted and
                // nothing will open one later. The held path also folds through
                // `add_sba_gain`, which would quietly re-file it as measured.
                if let Some(player) = self.party.get_mut(&actor_index) {
                    player.add_inferred_sba_gain(action, amount);
                }
                return;
            }
            SbaGainCause::InferredChainGrant => (SbaSourceKind::InferredChainGrant, None),
            SbaGainCause::InferredDamageTaken => (SbaSourceKind::InferredDamageTaken, None),
        };

        match self.party.get_mut(&actor_index) {
            Some(player) => player.add_sba_source(kind, id, amount),
            // Held rather than dropped: unlike a skill gain, a source has no row
            // to wait for and quest-start gauge legitimately precedes every hit.
            None => self
                .pending_player_sba_sources
                .entry(actor_index)
                .or_default()
                .push((kind, id, amount)),
        }
    }

    /// A gauge forced to a known level (attempt / perform / chain), which
    /// generates nothing.
    fn process_sba_level(&mut self, actor_index: u32, value: f64) {
        match self.party.get_mut(&actor_index) {
            Some(player) => player.set_sba(value),
            // A forced level replaces the held level but generates nothing,
            // so the held rise stays as it is.
            None => self.pending_player_sba.entry(actor_index).or_default().0 = value,
        }
    }

    /// Creates a player's party row before their first damage event, from the
    /// character type the identity snapshot carries — a player who only guards
    /// must still show their Perfect Guard rows. Folds in any guard/stun state
    /// already held pending for the slot. No-op (beyond the pending fold) when
    /// the row already exists.
    fn ensure_player_row(&mut self, actor_index: u32, character_type: CharacterType) {
        let pending_stun = self.pending_player_stun.remove(&actor_index);
        let pending_pg_stun = self.pending_player_pg_stun.remove(&actor_index);
        let pending_pg_quickening = self.pending_player_pg_quickening.remove(&actor_index);
        let pending_stun_effect = self.pending_player_stun_effect.remove(&actor_index);
        let pending_sources = self.pending_player_sba_sources.remove(&actor_index);
        let pending_sba = self.pending_player_sba.remove(&actor_index);
        let pending_sba_gains = self.pending_player_sba_gains.remove(&actor_index);
        let pending_taken = self.pending_player_taken.remove(&actor_index);

        let player = self
            .party
            .entry(actor_index)
            .or_insert_with(|| PlayerState::new(actor_index, character_type));

        if let Some(pending) = pending_stun {
            // Pending folds carry no timing context (they were held before the
            // row existed), so `i64::MIN` keeps them out of every guard window.
            player.add_stun_message(i64::MIN, pending);
        }
        if let Some(pending) = pending_pg_stun {
            for amount in pending {
                player.add_perfect_guard_stun(i64::MIN, amount);
            }
        }
        if let Some(pending) = pending_pg_quickening {
            for _ in 0..pending {
                player.add_perfect_guard_quickening();
            }
        }
        if let Some(pending) = pending_stun_effect {
            for amount in pending {
                player.add_stun_effect(amount);
            }
        }
        if let Some(sources) = pending_sources {
            for (kind, id, amount) in sources {
                player.add_sba_source(kind, id, amount);
            }
        }
        if let Some((value, generated)) = pending_sba {
            // The same shape a poll applies: the last held level, plus the sum
            // of every positive rise seen while the row didn't exist.
            player.apply_sba(value, generated);
        }
        if let Some(gains) = pending_sba_gains {
            for (action, amount) in gains {
                player.add_sba_gain(action, amount);
            }
        }
        if let Some(taken) = pending_taken {
            for event in taken {
                player.add_damage_taken(&event);
            }
        }
    }

    /// Folds one Perfect Guard stun capture into the encounter. Captured as a
    /// SOURCE-side accumulator delta on the enemy's guarded attack, so it is a
    /// DELTA-path amount: hit stun and guard stun share `stun_delta_sum`, and
    /// the max() dedupe against the message path keeps working (a message-path
    /// duplicate of the same accrual can never push the total past it).
    ///
    /// The identity snapshot (resolved from `player_data`) lets the guard
    /// create the player's row when they haven't dealt damage yet; without one
    /// the guard is held pending until their first damage event.
    fn process_perfect_guard_stun(
        &mut self,
        timestamp: i64,
        player_data: &[Option<PlayerData>; 4],
        actor_index: u32,
        amount: f64,
    ) {
        // A guard the LOCAL player made always registers its stun in-call, so 0
        // here means the guard applied none — the redundant counter events the
        // game fires alongside the real one (live capture 07-22: bursts of 30-40
        // within 150ms, no stun anywhere in the burst). Remote players are the
        // opposite case: their stun is host-authoritative and structurally
        // unobservable from this process (821 of 821 captured remote guards read
        // 0), so 0 carries no information there and the guard still counts. An
        // unidentified slot stays countable — unknown is not local.
        if amount <= 0.0 && is_remote_slot(player_data, actor_index) == Some(false) {
            return;
        }

        self.stun_delta_sum += amount;
        self.refresh_total_stun();
        let duration_secs = self.duration_secs();
        self.stun_per_second = self.total_stun_value / duration_secs;

        if let Some(character_type) = character_type_for_slot_key(player_data, actor_index) {
            self.ensure_player_row(actor_index, character_type);
        }
        if let Some(player) = self.party.get_mut(&actor_index) {
            player.add_perfect_guard_stun(timestamp, amount);
            player.stun_per_second = player.total_stun_value / duration_secs;
        } else {
            // No identity for the slot: hold it until the player's first
            // damage event creates their row.
            self.pending_player_pg_stun
                .entry(actor_index)
                .or_default()
                .push(amount);
        }
    }

    /// Counts one guarded Quickening (The World) for the player: a hits-only
    /// breakdown row. No stun or damage is tracked — the marker carries no
    /// measurable stun and the scripted counter damage is intentionally
    /// untracked (user decision). Row creation as in
    /// [`Self::process_perfect_guard_stun`].
    fn process_perfect_guard_quickening(
        &mut self,
        player_data: &[Option<PlayerData>; 4],
        actor_index: u32,
    ) {
        if let Some(character_type) = character_type_for_slot_key(player_data, actor_index) {
            self.ensure_player_row(actor_index, character_type);
        }
        if let Some(player) = self.party.get_mut(&actor_index) {
            player.add_perfect_guard_quickening();
        } else {
            // No identity for the slot: hold the count until the player's
            // first damage event creates their row.
            *self
                .pending_player_pg_quickening
                .entry(actor_index)
                .or_default() += 1;
        }
    }

    /// Folds one non-guard stun-effect proc (Eugen's sticky grenade) into the
    /// encounter: a DELTA-path amount (like Perfect Guard, it's a source-side
    /// accumulator delta with no damage event), routed to the player's own
    /// `StunEffect` row rather than Perfect Guard. Row creation / pending
    /// handling mirror [`Self::process_perfect_guard_stun`].
    fn process_stun_effect(
        &mut self,
        player_data: &[Option<PlayerData>; 4],
        actor_index: u32,
        amount: f64,
    ) {
        self.stun_delta_sum += amount;
        self.refresh_total_stun();
        let duration_secs = self.duration_secs();
        self.stun_per_second = self.total_stun_value / duration_secs;

        if let Some(character_type) = character_type_for_slot_key(player_data, actor_index) {
            self.ensure_player_row(actor_index, character_type);
        }
        if let Some(player) = self.party.get_mut(&actor_index) {
            player.add_stun_effect(amount);
            player.stun_per_second = player.total_stun_value / duration_secs;
        } else {
            // No identity for the slot: hold it until the player's first
            // damage event creates their row.
            self.pending_player_stun_effect
                .entry(actor_index)
                .or_default()
                .push(amount);
        }
    }
}

/// v2.0.2: the hook can no longer resolve Id's dragon form (Pl2000) to its Pl1900
/// owner — the parent-link offset vanished in the patch — so dragon events arrive
/// parented to themselves and would open a separate party row. Remap them onto the
/// party's Id (Pl1900) player at derive time. The raw event log keeps the original
/// event, so a future hook-side parent fix reparses history cleanly.
///
/// Falls back to the unmapped event when no Pl1900 player is known (e.g. an AI Id,
/// which has no identity on v2.0.2) — same split behavior as before, never lost damage.
pub fn remap_dragon_form(
    player_data: &[Option<PlayerData>; 4],
    event: &DamageEvent,
) -> DamageEvent {
    let mut event = event.clone();

    if CharacterType::from_hash(event.source.parent_actor_type) == CharacterType::Pl2000 {
        if let Some(owner) = player_data
            .iter()
            .flatten()
            .find(|player| player.character_type == CharacterType::Pl1900)
        {
            event.source.parent_index = owner.actor_index;
            event.source.parent_actor_type = 0x8056ABCD; // Pl1900
        }
    }

    event
}

/// The character a player-identity/load event should record in its party slot.
///
/// Pl2000 (Id's dragon form) events resolve to the Id player (Pl1900) instead of
/// being dropped: a recruited crewmate Id fights entirely in dragon form — its
/// Pl1900 base actor may never deal a hit — so dragon-sourced events are the only
/// identity the meter ever sees for that player (live logs 344-346, 2026-07-23,
/// where slot 4 stayed empty all quest). Slot-scoped, so two Ids in one party
/// each keep their own entry. `None` means ignore the event: its slot is owned by
/// a different character (bad embedded-record read) or out of range.
fn slot_character_for_identity(
    player_data: &[Option<PlayerData>; 4],
    character_type: CharacterType,
    party_index: u8,
) -> Option<CharacterType> {
    if character_type != CharacterType::Pl2000 {
        return Some(character_type);
    }
    let slot = player_data.get(party_index as usize)?;
    match slot {
        Some(holder) if holder.character_type != CharacterType::Pl1900 => None,
        _ => Some(CharacterType::Pl1900),
    }
}

/// Resolves the character type behind a player slot key (`0xF0000000 | slot`)
/// from the identity snapshots. Identity events land at quest load — before a
/// guard is possible — so this lets guard handlers create a party row for a
/// player who has not dealt any damage yet. `None` for non-slot-key values or
/// slots with no identity (the caller then falls back to holding the guard
/// pending).
fn character_type_for_slot_key(
    player_data: &[Option<PlayerData>; 4],
    slot_key: u32,
) -> Option<CharacterType> {
    player_data[protocol::party_slot_of(slot_key)?]
        .as_ref()
        .map(|player| player.character_type)
}

/// Whether the slot's player belongs to a REMOTE client, or `None` while the
/// slot has no identity yet (locality unknown — callers must not assume local).
///
/// This decides whether a measurement of 0 means "nothing happened" or "not
/// observable here": the hook reads the enemy's stun accumulator across the
/// guarded call in THIS process, which only sees stun the local client applies.
fn is_remote_slot(player_data: &[Option<PlayerData>; 4], slot_key: u32) -> Option<bool> {
    player_data[protocol::party_slot_of(slot_key)?]
        .as_ref()
        .map(|player| player.is_online)
}

/// Cap on charted HP pools: beyond this many lines the chart is unreadable, so
/// only the largest pools (bosses dwarf adds and breakable parts) are kept.
/// Generous because summon waves legitimately produce many series (Lucilius
/// spawns 3 swords, three times).
pub const HP_CHART_MAX_SERIES: usize = 12;

/// One enemy HP pool charted on the quest-details view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HpChartSeries {
    pub enemy_type: EnemyType,
    /// 1-based occurrence among charted pools sharing `enemy_type`, so the
    /// frontend can disambiguate duplicate labels ("Goblin #2").
    pub instance: u32,
    pub max_hp: u64,
    /// Post-hit HP% per time bucket; `None` where the pool wasn't hit (HP only
    /// changes when hit, so consumers forward-fill across the gaps).
    pub values: Vec<Option<f32>>,
}

/// A caller-selected slice of one target spawn's lifetime (the selectable half
/// of a [`TargetSegment`]). The spawn id alone is NOT unique across a fight —
/// the game reuses freed actor instances (wave 2's sword lands on wave 1's
/// pointer) — so selections carry the segment's time span too.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpan {
    pub id: u32,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// One contiguous lifetime of one enemy spawn: a `target.index` key from its
/// first damage event until a respawn boundary (its max HP changes, or its HP
/// jumps back to near-full — see [`segment_targets`]). The quest-details
/// target dropdown lists exactly these, and the HP chart draws one series per
/// segment, so the two stay in 1:1 parity (matching `instance` numbers).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSegment {
    pub id: u32,
    /// The game's own actor index for this spawn (`target.parent_index`).
    ///
    /// `id` above is the spawn's INSTANCE POINTER folded to 32 bits, which is
    /// what tells two simultaneous same-kind actors apart. The status hook
    /// cannot report that — it sees the actor, not the damage instance — and
    /// sends this index instead, so it is the only field the two capture paths
    /// share and the only one a status window can be matched on.
    ///
    /// Coarser than `id` by design: sibling summons collapse onto one actor
    /// index (Lucilius' three swords), which is why the damage path stopped
    /// keying on it. For a boss, the one case debuff attribution matters for,
    /// it is unambiguous, and [`status::segment_at`] disambiguates sequential
    /// reuse by time.
    pub actor_index: u32,
    pub enemy_type: EnemyType,
    /// 1-based, chronological within `enemy_type` — the "#n" in both UIs.
    pub instance: u32,
    /// The pool's max HP (`None` on logs recorded before HP capture).
    pub max_hp: Option<u64>,
    /// First/last damage event of the segment, ms relative to the log start.
    pub start_ms: i64,
    pub end_ms: i64,
}

// A respawn behind a reused key must show REAL evidence, not just a value
// rising toward full — on pre-per-spawn-id logs several simultaneous summons
// interleave on one key, and "sword A at 90%, then a splash hit on near-full
// sword B" must not read as a respawn. Evidence = the jump lands near full AND
// either the pool was nearly dead, or the key went quiet for a wave-length gap
// (waves are minutes apart; interleaved hits are milliseconds apart — and the
// gap also catches a wave despawning mid-HP at a boss phase change).
const RESPAWN_FRACTION: f64 = 0.95;
const NEARLY_DEAD_FRACTION: f64 = 0.25;
const RESPAWN_QUIET_GAP_MS: i64 = 30_000;

/// One distinct combination present in the log: who dealt it, what they used,
/// and what they hit.
///
/// Source is the PARENT actor, matching [`matches_selection`]: a summon's hit
/// is offered under the player who called it, not under the summon body.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFact {
    pub source_actor_type: u32,
    pub source_index: u32,
    /// Index into the [`TargetSegment`] vector this fight segments into — i.e.
    /// into the `targetEntries` the same response carries.
    ///
    /// The SEGMENT, never `target.index`: the game frees a dead boss's actor
    /// index and reissues it (live, "Four Dragons of the Apocalypse": Wilinus
    /// Icewyrm and Vrazarek Firewyrm both arrived as `3926405961`). Keyed by the
    /// index the two collapsed into one dropdown entry, the second dragon never
    /// appeared, and pinning the first showed both dragons' damage. A segment is
    /// one spawn, which is what the user means by "this enemy".
    pub target_segment: usize,
    pub ability: ActionType,
    /// The body the hit came from, filed the way `skill_breakdown` files it.
    ///
    /// Present so the ability selector can condense its list into skill groups
    /// with the same rule the table uses — grouping is per child character, and
    /// the action alone cannot say which group it belongs to.
    pub child_character_type: CharacterType,
}

/// The distinct [`SelectionFact`]s in `events`, in first-seen order.
///
/// Computed with the time window applied but the selector pins NOT applied:
/// cascading needs the full population of each dimension given the *others*,
/// and filtering by the pins first would collapse every list to what is already
/// selected. The window IS applied, so the selectors only ever offer a pin that
/// has something behind it.
/// True for a hit some enemy dealt TO a party member — the damage-taken
/// stream, which has its own accumulation and must stay out of every
/// dealt-damage path (DPS totals, target segments, selection facts, coverage).
///
/// Identity-only, both sides: the target carries a party slot key (the hook
/// slot-keys player victims the same way it keys player sources) and the
/// source's parent is no known player character. A player-sourced hit on a
/// player keeps flowing through the dealt pipeline unchanged.
/// Does this event exist for a reparse run with these bounds?
///
/// The scrub range and the window-filter mask, in one place. `reparse_with_options`'s
/// main loop and the SBA inference pass that follows it both decide through
/// this, because inference joins against the very events the derived state was
/// built from — if it saw an event the loop excluded, it could name gauge that
/// is not in the polled total it is meant to be splitting.
fn admits_event(
    timestamp: i64,
    from: Option<i64>,
    cutoff: Option<i64>,
    windows: Option<&[TimeWindow]>,
    log_start: i64,
) -> bool {
    if cutoff.is_some_and(|cutoff| timestamp > cutoff) {
        return false;
    }
    if from.is_some_and(|from| timestamp < from) {
        return false;
    }
    match windows {
        Some(windows) => {
            let rel_ts = timestamp - log_start;
            windows.iter().any(|window| window.admits(rel_ts))
        }
        None => true,
    }
}

pub fn is_damage_taken_event(event: &DamageEvent) -> bool {
    protocol::is_player_slot_key(event.target.parent_index)
        && matches!(
            CharacterType::from_hash(event.source.parent_actor_type),
            CharacterType::Unknown(_)
        )
}

pub fn selection_facts(
    events: &[(i64, Message)],
    start_time: i64,
    from_ms: Option<i64>,
    up_to_ms: Option<i64>,
    assignment: &[Option<usize>],
) -> Vec<SelectionFact> {
    let mut seen = HashSet::new();
    let mut facts = Vec::new();

    for (event_index, (timestamp, message)) in events.iter().enumerate() {
        let Message::DamageEvent(event) = message else {
            continue;
        };

        let rel_ms = timestamp - start_time;
        if from_ms.is_some_and(|from| rel_ms < from) || up_to_ms.is_some_and(|up_to| rel_ms > up_to)
        {
            continue;
        }

        // No segment = not a selectable enemy (a phantom marker actor, which the
        // segmenter deliberately skips). The dropdown lists enemies, so a hit
        // with nowhere to belong is not offered rather than given a bogus home.
        let Some(Some(target_segment)) = assignment.get(event_index).copied() else {
            continue;
        };

        let fact = SelectionFact {
            source_actor_type: event.source.parent_actor_type,
            source_index: event.source.parent_index,
            target_segment,
            ability: event.action_id,
            child_character_type: player_state::child_character_type_for(event),
        };
        // The child is part of the identity, not just payload: one player can
        // hold two group rows of the same name (Id and his dragon form share
        // three), and collapsing them here would hide one from the selector.
        if seen.insert((
            fact.source_actor_type,
            fact.source_index,
            fact.target_segment,
            fact.ability,
            fact.child_character_type,
        )) {
            facts.push(fact);
        }
    }

    facts
}

/// The game's own damage-cap-up totals for one player, by attack class.
///
/// These are TOTALS, not contributions: the game has already summed every
/// sigil, trait, node and bonus into each one before the hook sees it. A
/// breakdown derived from the stored loadout is reconciled against them, and
/// whatever it cannot account for is reported rather than hidden.
///
/// Every field is optional and independently so — a record read that resolved
/// two classes must not claim zero for the third, which would render as a base
/// cap equal to the logged cap and a confident 0% unaccounted.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCapUp {
    pub normal: Option<f32>,
    pub skill: Option<f32>,
    pub sba: Option<f32>,
}

impl PlayerCapUp {
    fn is_empty(&self) -> bool {
        self.normal.is_none() && self.skill.is_none() && self.sba.is_none()
    }
}

/// Cap-up totals keyed by the slot key a damage row already carries as
/// `source.parent_index`, so the events table can join without a second lookup.
///
/// Players with nothing captured are OMITTED rather than mapped to an empty
/// entry: absent means "this log predates the capture", and the card must show
/// its Stage-1 rows for those instead of a cap-up block full of zeroes.
pub fn cap_up_by_source(player_data: &[Option<PlayerData>]) -> BTreeMap<u32, PlayerCapUp> {
    player_data
        .iter()
        .flatten()
        .filter_map(|player| {
            let cap_up = PlayerCapUp {
                normal: player.cap_up_normal,
                skill: player.cap_up_skill,
                sba: player.cap_up_sba,
            };
            (!cap_up.is_empty()).then_some((player.actor_index, cap_up))
        })
        .collect()
}

/// One page of the raw event stream, with timestamps rebased to the fight start.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// `(ms since fight start, event)`. The inner [`Message`] serialises with
    /// serde's DEFAULTS — externally tagged, snake_case fields — so the
    /// frontend's `LogEvent` mirror is snake_case inside the variant.
    pub events: Vec<(i64, Message)>,
    /// How many events exist in total, so the frontend can tell a full answer
    /// from a truncated one.
    pub total: usize,
    /// [`cap_up_by_source`] for this encounter's party.
    ///
    /// Rides the page rather than the event stream because identity events never
    /// reach `raw_event_log` — only damage, stun, status, SBA, link and enemy
    /// mode do — so the loadout is not in the stream to read. This is the one
    /// fetch the events table already makes, and its only consumer.
    #[serde(default)]
    pub cap_up: BTreeMap<u32, PlayerCapUp>,
}

/// `count` events starting at `offset`, rebased to `start_time`.
///
/// An offset past the end yields an empty page rather than panicking: the
/// frontend's scroll position and the backend's event count can disagree for a
/// frame after a filter change.
pub fn event_page(
    events: &[(i64, Message)],
    player_data: &[Option<PlayerData>],
    start_time: i64,
    offset: usize,
    count: usize,
) -> EventPage {
    let total = events.len();
    let end = offset.saturating_add(count).min(total);
    let slice = if offset >= total {
        &events[0..0]
    } else {
        &events[offset..end]
    };

    EventPage {
        events: slice
            .iter()
            .map(|(ts, event)| (ts - start_time, event.clone()))
            .collect(),
        total,
        cap_up: cap_up_by_source(player_data),
    }
}

/// Split every damage-event target into [`TargetSegment`]s, in first-hit
/// order. Events without HP data still open/extend segments (DoT-only spans,
/// old logs) — they just can't trigger respawn boundaries.
pub fn segment_targets(events: &[(i64, Message)], start_time: i64) -> Vec<TargetSegment> {
    segment_targets_inner(events, start_time, false).0
}

/// [`segment_targets`], plus which segment each event belongs to (`None` for
/// non-damage events), parallel to `events`.
///
/// Callers that must partition the event stream by segment need this rather than
/// the timestamps: a phase change opens a new segment at the SAME millisecond as
/// the outgoing segment's last event, so a time-based split files the new pool's
/// damage against the old one.
pub fn segment_targets_indexed(
    events: &[(i64, Message)],
    start_time: i64,
) -> (Vec<TargetSegment>, Vec<Option<usize>>) {
    segment_targets_inner(events, start_time, true)
}

/// The shared segmenter. `track` is opt-in because the assignment vector costs
/// one entry per event and only the audit tooling reads it — the interactive
/// callers (`fetch_encounter_state` on every log open, target-filter change and
/// filter toggle) would otherwise allocate and populate it just to drop it.
fn segment_targets_inner(
    events: &[(i64, Message)],
    start_time: i64,
    track: bool,
) -> (Vec<TargetSegment>, Vec<Option<usize>>) {
    struct KeyState {
        position: usize,
        max: Option<u64>,
        last_current: Option<u64>,
        last_ts: i64,
    }

    let mut segments: Vec<TargetSegment> = Vec::new();
    let mut live: HashMap<u32, KeyState> = HashMap::new();
    let mut assignment: Vec<Option<usize>> = if track {
        vec![None; events.len()]
    } else {
        Vec::new()
    };

    // Markers are not enemies, so they get no dropdown entry and no HP series —
    // and because the assignment vector is pre-filled with `None`, skipping one
    // leaves its slot unassigned, exactly like a non-damage event.
    let phantoms = PhantomTargets::learned_from(events.iter());

    for (event_index, (timestamp, message)) in events.iter().enumerate() {
        let Message::DamageEvent(event) = message else {
            continue;
        };
        // Party victims are not targets: an incoming hit would otherwise put
        // the PLAYER in the target dropdown and their HP pool in the enemy-HP
        // charts. Left unassigned, exactly like a non-damage event, which also
        // keeps enemy attacks out of `selection_facts`.
        if is_damage_taken_event(event) {
            continue;
        }
        if phantoms.is_phantom(event) {
            continue;
        }
        let rel_ts = timestamp - start_time;
        let hp = event.target_current_hp.zip(event.target_max_hp);
        let key = event.target.index;

        let boundary = match (live.get(&key), hp) {
            (None, _) => true,
            (Some(state), Some((current, max))) => {
                let max_changed = state.max.is_some_and(|known| known != max);
                let respawned = state.last_current.is_some_and(|last| {
                    current > last
                        && current as f64 >= max as f64 * RESPAWN_FRACTION
                        && (last as f64 <= max as f64 * NEARLY_DEAD_FRACTION
                            || rel_ts - state.last_ts >= RESPAWN_QUIET_GAP_MS)
                });
                max_changed || respawned
            }
            (Some(_), None) => false,
        };

        if boundary {
            segments.push(TargetSegment {
                id: key,
                // The bridge to the status events, which know an enemy only by
                // this index — see `TargetSegment::actor_index`.
                actor_index: event.target.parent_index,
                enemy_type: EnemyType::from_hash(event.target.parent_actor_type),
                instance: 0, // numbered below
                max_hp: hp.map(|(_, max)| max),
                start_ms: rel_ts,
                end_ms: rel_ts,
            });
            live.insert(
                key,
                KeyState {
                    position: segments.len() - 1,
                    max: hp.map(|(_, max)| max),
                    last_current: hp.map(|(current, _)| current),
                    last_ts: rel_ts,
                },
            );
            if track {
                assignment[event_index] = Some(segments.len() - 1);
            }
        } else if let Some(state) = live.get_mut(&key) {
            if track {
                assignment[event_index] = Some(state.position);
            }
            let segment = &mut segments[state.position];
            segment.end_ms = rel_ts;
            // `last_ts` is the quiet-gap clock, so EVERY event touching this key resets
            // it — including hp-less ones (DoT ticks). Updating it only on hp-carrying
            // events let a boss that took nothing but DoT for 30s, then healed to full at
            // a phase change, read as a respawn and split into a phantom second instance.
            state.last_ts = rel_ts;
            if let Some((current, max)) = hp {
                segment.max_hp = Some(max);
                state.max = Some(max);
                state.last_current = Some(current);
            }
        }
    }

    // Chronological per-type numbering (EnemyType has no Hash; n is tiny).
    let mut counts: Vec<(EnemyType, u32)> = Vec::new();
    for segment in &mut segments {
        match counts
            .iter_mut()
            .find(|(enemy_type, _)| *enemy_type == segment.enemy_type)
        {
            Some((_, count)) => {
                *count += 1;
                segment.instance = *count;
            }
            None => {
                counts.push((segment.enemy_type, 1));
                segment.instance = 1;
            }
        }
    }

    (segments, assignment)
}

/// Whether a damage event's target passes the quest-details filter: with no
/// spans selected everything passes; otherwise one of the selected spawn spans
/// (id + time window) must match. Spans let the UI select ONE summon out of
/// several sharing an enemy type — and one wave out of several reusing an
/// instance id.
pub fn target_selected(
    rel_ts: i64,
    event: &protocol::DamageEvent,
    target_spans: &[TargetSpan],
) -> bool {
    target_spans.is_empty()
        || target_spans.iter().any(|span| {
            span.id == event.target.index && span.start_ms <= rel_ts && rel_ts <= span.end_ms
        })
}

/// Per-player, per-second damage buckets for the logs page's DPS charts.
///
/// Lives here rather than inline in `fetch_encounter_state` so the filtering and
/// target-span rules it shares with the meter can be tested without a database.
/// `player_indices` are the derived party's keys: chart rows exist only for
/// players the meter itself shows, and damage credited to anyone else is dropped
/// rather than inventing a row for them.
///
/// A bucket index IS the elapsed second — both the quest-details charts and the
/// window scrubber work in whole seconds — so `chart_len` must be sized from the
/// FULL log duration even when a scrub cutoff truncates the derived state, or
/// this indexes out of bounds.
// Eight independent inputs with no natural grouping — the event log, who to
// build rows for, the bucket geometry, and the two filters. Bundling them into
// a struct would only move the same list somewhere less readable.
pub fn build_player_dps_chart(
    events: &[(i64, Message)],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    scope: &ChartScope,
) -> HashMap<u32, Vec<i32>> {
    let player_data = scope.player_data;
    let mut player_dps: HashMap<u32, Vec<i32>> = player_indices
        .iter()
        .map(|index| (*index, vec![0; chart_len]))
        .collect();

    // Same rule as the meter, so a chart's area can't disagree with the row
    // total it sits under.
    let phantoms = PhantomTargets::learned_from(events.iter());

    for (timestamp, event) in events {
        let Message::DamageEvent(damage_event) = event else {
            continue;
        };

        if phantoms.is_phantom(damage_event) || !scope.counted(damage_event) {
            continue;
        }

        // The RAW action, read before the dragon-form remap below — that remap
        // rewrites the source, never the action, so the two are independent.
        if !scope.selects_ability(damage_event.action_id) {
            continue;
        }

        // Attribute dragon-form (Id/Pl2000) damage to the Id player, matching the
        // remap the party table uses — otherwise the party (keyed by the remapped
        // index) has no bucket for the raw Pl2000 index and the chart drops it.
        let damage_event = remap_dragon_form(player_data, damage_event);

        let Some(chart) = player_dps.get_mut(&damage_event.source.parent_index) else {
            continue;
        };

        // Check to see if the target is in the list of targets to filter by.
        if scope.selects_target(timestamp - start_time, &damage_event) {
            chart[((timestamp - start_time) / interval) as usize] += damage_event.damage;
        }
    }

    player_dps
}

/// Per-player, per-second damage TAKEN buckets for the analysis view's Taken
/// chart, keyed by the victim's slot key.
///
/// Only incoming events (see [`is_damage_taken_event`]) count, and only onto
/// the party keys given — same posture as [`build_player_dps_chart`]. None of
/// that function's gates apply here: phantom targets and the exclusion filters
/// are about hits ON enemies, an enemy attack is not a pinnable ability, and
/// the victim is a player rather than a target span.
/// Damage TAKEN per bucket, keyed by the victim's slot key.
///
/// The one chart builder that takes NO [`ChartScope`], stated here so its
/// absence reads as a decision rather than the omission that produced the
/// ability-pin bug. None of the gates apply: the contested-source filters and
/// the ability pin both speak the grammar of a PLAYER's outgoing hits, and this
/// walks the incoming stream, where the actor is an enemy and the action is an
/// enemy attack. Narrowing it by either would silently answer a question about
/// the wrong side of the fight.
pub fn build_player_taken_chart(
    events: &[(i64, Message)],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
) -> HashMap<u32, Vec<i64>> {
    let mut player_taken: HashMap<u32, Vec<i64>> = player_indices
        .iter()
        .map(|index| (*index, vec![0; chart_len]))
        .collect();

    for (timestamp, event) in events {
        let Message::DamageEvent(damage_event) = event else {
            continue;
        };
        if !is_damage_taken_event(damage_event) {
            continue;
        }
        let Some(chart) = player_taken.get_mut(&damage_event.target.parent_index) else {
            continue;
        };
        // Bounds-checked like every other bucketing walk (`bucket_for`, and
        // `aggregate_groups`'s taken branch): `chart_len` is sized from the
        // LAST raw event's wall-clock stamp, not the maximum one, so a clock
        // step during a fight can put an event outside it. Indexing an
        // unchecked bucket would panic inside `fetch_encounter_state` and the
        // log would simply refuse to open.
        let bucket = ((timestamp - start_time) / interval) as usize;
        if bucket >= chart_len {
            continue;
        }
        chart[bucket] += damage_event.damage.max(0) as i64;
    }

    player_taken
}

/// Build the per-player stun chart: stun applied per bucket, keyed by actor
/// index.
///
/// Not a clone of [`build_player_dps_chart`], because stun does not simply
/// accumulate. It arrives by two independent paths that observe the SAME game
/// accumulator — per-hit deltas on damage events (the solo path) and network
/// stun messages (the online path, where the delta method structurally reads
/// 0) — and the meter reconciles them with `max(delta_sum, message_sum)`, not a
/// sum. Solo loopback fires both for one accrual, so adding them double-counts.
///
/// `max` does not decompose per bucket (`max` of sums is not the sum of
/// `max`es), so this walks the log once to learn which path won FOR EACH PLAYER
/// and then buckets only that path. The series therefore sums to exactly the
/// `total_stun_value` the table reports — a chart's area cannot disagree with
/// the row total it sits under.
///
/// Every gate the reparse loop applies is mirrored here: phantom and filter
/// exclusion, the excluded-hit stun suppression that stops a message being
/// credited to the skill before it, the dragon-form remap, and Perfect Guard's
/// local-versus-remote zero rule. Stun messages carry no target, so target
/// spans do not gate them (enemy stun is effectively boss-wide).
pub fn build_player_stun_chart(
    events: &[(i64, Message)],
    player_indices: &[u32],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    scope: &ChartScope,
) -> HashMap<u32, Vec<f64>> {
    let player_data = scope.player_data;
    let empty = || -> HashMap<u32, Vec<f64>> {
        player_indices
            .iter()
            .map(|index| (*index, vec![0.0; chart_len]))
            .collect()
    };
    let mut delta = empty();
    let mut message = empty();

    let phantoms = PhantomTargets::learned_from(events.iter());
    // Mirrors `DerivedEncounterState::stun_suppressed_players`: an excluded hit
    // claims the message trailing it so it is dropped, and the next counted
    // stun-capable hit takes that claim back.
    let mut suppressed: HashSet<u32> = HashSet::new();

    for (timestamp, event) in events {
        let bucket = ((timestamp - start_time) / interval) as usize;
        if bucket >= chart_len {
            continue;
        }

        match event {
            Message::DamageEvent(damage_event) => {
                if phantoms.is_phantom(damage_event) {
                    continue;
                }
                if !scope.counted(damage_event) {
                    // `note_excluded_damage`: supplementary and DoT hits never
                    // own a stun message, so they cannot suppress one.
                    if !matches!(
                        damage_event.action_id,
                        ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
                    ) {
                        suppressed.insert(damage_event.source.parent_index);
                    }
                    continue;
                }

                let damage_event = remap_dragon_form(player_data, damage_event);

                if !matches!(
                    damage_event.action_id,
                    ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
                ) {
                    suppressed.remove(&damage_event.source.parent_index);
                }

                let Some(chart) = delta.get_mut(&damage_event.source.parent_index) else {
                    continue;
                };
                // The ability pin, which this walk did not apply before the
                // gates moved onto `ChartScope` — the per-player stun chart
                // spanned every ability while the table beneath it narrowed.
                if scope.selects_ability(damage_event.action_id)
                    && scope.selects_target(timestamp - start_time, &damage_event)
                {
                    chart[bucket] += damage_event.stun_value.unwrap_or(0.0) as f64;
                }
            }
            Message::OnPlayerStun(stun) => {
                if suppressed.contains(&stun.actor_index) {
                    continue;
                }
                if let Some(chart) = message.get_mut(&stun.actor_index) {
                    chart[bucket] += stun.stun_amount as f64;
                }
            }
            Message::OnPerfectGuardStun(guard) => {
                // A local guard always registers its stun in-call, so 0 means it
                // applied none. Remote guards are host-authoritative and read 0
                // regardless, so 0 carries no information there.
                if guard.stun_amount <= 0.0
                    && is_remote_slot(player_data, guard.actor_index) == Some(false)
                {
                    continue;
                }
                if let Some(chart) = delta.get_mut(&guard.actor_index) {
                    chart[bucket] += guard.stun_amount as f64;
                }
            }
            Message::OnStunEffect(effect) => {
                if let Some(chart) = delta.get_mut(&effect.actor_index) {
                    chart[bucket] += effect.stun_amount as f64;
                }
            }
            _ => {}
        }
    }

    // Per player, keep whichever path saw the accrual — the bucketed mirror of
    // `PlayerState::refresh_total_stun`.
    player_indices
        .iter()
        .map(|index| {
            let deltas = delta.remove(index).unwrap_or_default();
            let messages = message.remove(index).unwrap_or_default();
            let series = if deltas.iter().sum::<f64>() >= messages.iter().sum::<f64>() {
                deltas
            } else {
                messages
            };
            (*index, series)
        })
        .collect()
}

/// Build the quest-details enemy HP charts: one series per [`TargetSegment`]
/// with HP data passing the filter, largest max-HP first (stable, so same-size
/// series keep spawn order), capped at [`HP_CHART_MAX_SERIES`]. Series carry
/// the segment's `instance` number, so chart labels match the target dropdown.
/// Within a bucket the last report wins. Old logs carry no HP data and yield
/// no series.
///
/// `segments` MUST be [`segment_targets`] of the same `events`/`start_time` —
/// sharing the caller's segmentation (rather than recomputing it) is what
/// guarantees the 1:1 chart↔dropdown parity.
pub fn build_target_hp_charts(
    events: &[(i64, Message)],
    segments: &[TargetSegment],
    start_time: i64,
    interval: i64,
    chart_len: usize,
    scope: &ChartScope,
) -> Vec<HpChartSeries> {
    let mut series_by_segment: Vec<Option<HpChartSeries>> = vec![None; segments.len()];

    // Spawn ids repeat across waves but a fight has few segments per id; index
    // by id so the per-event lookup scans a handful of spans, not every segment.
    let mut positions_by_id: HashMap<u32, Vec<usize>> = HashMap::new();
    for (position, segment) in segments.iter().enumerate() {
        positions_by_id
            .entry(segment.id)
            .or_default()
            .push(position);
    }

    for (timestamp, message) in events {
        let Message::DamageEvent(event) = message else {
            continue;
        };
        let (Some(current), Some(max)) = (event.target_current_hp, event.target_max_hp) else {
            continue;
        };
        let rel_ts = timestamp - start_time;
        // The only gate an HP series takes: which SPAWNS are charted. The
        // ability and contested-source filters are about a hit's attribution,
        // and an enemy's health is not attributed to anyone.
        if !scope.selects_target(rel_ts, event) {
            continue;
        }
        // Newest matching segment wins. A respawn boundary gives the closing segment an
        // `end_ms` equal to the opening one's `start_ms`, and both bounds are inclusive —
        // scanning forward charted the new wave's first (near-full) report onto the dead
        // wave's line, which reads as a heal.
        let Some(position) = positions_by_id
            .get(&event.target.index)
            .into_iter()
            .flatten()
            .rev()
            .copied()
            .find(|&position| {
                let segment = &segments[position];
                segment.start_ms <= rel_ts && rel_ts <= segment.end_ms
            })
        else {
            continue;
        };

        let series = series_by_segment[position].get_or_insert_with(|| HpChartSeries {
            enemy_type: segments[position].enemy_type,
            instance: segments[position].instance,
            max_hp: max,
            values: vec![None; chart_len],
        });
        let bucket = (rel_ts / interval) as usize;
        if let Some(slot) = series.values.get_mut(bucket) {
            *slot = Some((current as f64 / max as f64 * 100.0) as f32);
        }
    }

    let mut charts: Vec<HpChartSeries> = series_by_segment.into_iter().flatten().collect();
    charts.sort_by_key(|series| std::cmp::Reverse(series.max_hp));
    charts.truncate(HP_CHART_MAX_SERIES);
    charts
}

/// The pre-remap half of the gate chain the analysis view's
/// [`groups::aggregate_groups`] applies: phantom targets and the
/// contested-source exclusion filter. Split from [`bucket_for`] because a
/// caller's own ability narrowing belongs BETWEEN these two halves — it must
/// see the raw event (the remap never touches `action_id`, but it does
/// rewrite `source`, which a source narrowing downstream must see remapped).
fn survives_shared_gates(
    event: &DamageEvent,
    phantoms: &PhantomTargets,
    filters: MeterFilters,
) -> bool {
    !phantoms.is_phantom(event) && !is_excluded(event, &filters)
}

/// The post-remap half of the gate chain: the target-span window and the
/// bucket bounds, applied to an already-remapped event. `None` means the hit
/// is out of the selected window or lands past the chart entirely.
fn bucket_for(
    rel_ts: i64,
    event: &DamageEvent,
    target_spans: &[TargetSpan],
    interval: i64,
    chart_len: usize,
) -> Option<usize> {
    if !target_selected(rel_ts, event, target_spans) {
        return None;
    }
    let bucket = (rel_ts / interval) as usize;
    (bucket < chart_len).then_some(bucket)
}

/// The parser for the encounter.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Parser {
    /// Encounter that will be saved into the database, contains all the state needed to reparse
    pub encounter: Encounter,
    /// Derived state of the encounter, used for parsing the encounter into a calculated format that can be consumed by the front-end
    pub derived_state: DerivedEncounterState,
    /// Status of the parser
    status: ParserStatus,

    /// Which contested damage sources the derived state counts. Runtime
    /// configuration rather than encounter data, so it is skipped: baking it
    /// into a stored log would freeze one user's preference into the file, and
    /// the whole point is that the raw log stays neutral.
    #[serde(skip)]
    pub filters: MeterFilters,

    /// Which source actors and abilities the quest view's selector bar has
    /// pinned. Skipped for the same reason as [`Self::filters`] — it is what
    /// someone is currently looking at, not something about the fight.
    /// [`Default`] is every dimension unpinned, so the live path and every
    /// caller that never sets it derive the whole encounter.
    #[serde(skip)]
    pub selection: SelectionFilter,

    /// Target actor types this encounter has shown to be markers rather than
    /// enemies (see [`phantom_targets`]). Derived from the raw log, so it is
    /// rebuilt on every reparse and never stored.
    #[serde(skip)]
    phantom_targets: PhantomTargets,

    /// The window handle for the parser, used to send messages to the front-end
    #[serde(skip)]
    app: Option<AppHandle>,

    /// The window handle for the parser, used to send messages to the front-end
    #[serde(skip)]
    window_handle: Option<Window>,

    /// The database connection for the parser, used to save the encounter
    #[serde(skip)]
    db: Option<Connection>,

    /// Active Conflux run id (None when not in a run). Assigned on run-start.
    #[serde(skip)]
    active_run_id: Option<i64>,
    /// `EndlessModeQuestManager` pointer identifying the active run (0 when none).
    /// A room-enter with a different manager pointer opens a new run.
    #[serde(skip)]
    active_run_manager: u64,
    /// 0-based index of the room currently being recorded within the active run.
    #[serde(skip)]
    active_room_index: u32,
    /// Per-room buff deltas accumulated during the active run.
    #[serde(skip)]
    active_run_buffs: Vec<ConfluxBuffDelta>,
    /// Start timestamp (ms) of the active run.
    #[serde(skip)]
    active_run_start: i64,
    /// A genuine quest-complete result screen (type 5) was seen during the active run.
    /// The manager dtor rarely fires, so this is the primary "cleared" signal.
    #[serde(skip)]
    active_run_completed: bool,

    /// Id of the first saved run of the current Repeat Quest chain. Set by the
    /// first completed save after a quest load and stamped onto every later
    /// normal save, until a boundary that implies leaving the chain (quest
    /// load, wipe/retire, training, Conflux) clears it. Repeat runs are
    /// exactly the runs that start without a quest load in between — the game
    /// skips `on_load_quest_state` on Repeat Quest.
    #[serde(skip)]
    repeat_chain_anchor: Option<i64>,

    /// Every status currently ACTIVE in the game, keyed the way removes pair
    /// with applies (holder, effect, causing action) and holding the latest
    /// apply. Maintained across encounter boundaries, because the statuses a
    /// fight starts under are applied OUTSIDE it: quest-start buffs (Guts,
    /// Autorevive, the sigil passives) land seconds before the first damage
    /// event, and on a Repeat Quest chain they are never re-applied at all.
    /// [`Self::ensure_encounter_started`] seeds these into each new
    /// encounter's raw log; a quest load ([`Self::on_area_enter_event`])
    /// clears the map, so a stale town buff cannot haunt later fights.
    /// BTreeMap so the seeding order — and with it the stored log — is
    /// deterministic.
    #[serde(skip)]
    standing_statuses: BTreeMap<(u32, u32, Option<u32>), protocol::StatusApplyEvent>,

    /// The party's verdicts as last computed, so the per-hit identity path can
    /// re-broadcast them without re-auditing four builds. Recomputed only when
    /// the party actually changes — see [`Parser::insert_player_data`].
    #[serde(skip)]
    last_party_legality: [Vec<crate::legality::Finding>; 4],

    /// Rate limiter for `encounter-update`. Fresh derived state is produced by
    /// every hit, stun and SBA message; the overlay is told about it at 10Hz.
    /// See [`live_emit`] for why, and for the trailing-flush contract that
    /// keeps the last state of a fight from being the one that got suppressed.
    #[serde(skip)]
    encounter_update_throttle: live_emit::EmitThrottle,
}

impl Parser {
    pub fn new(app: AppHandle, window: Window, db: Connection) -> Self {
        Self {
            app: Some(app),
            db: Some(db),
            window_handle: Some(window),
            ..Default::default()
        }
    }

    /// Tells the overlay the encounter changed, at most 10× a second.
    ///
    /// Called from the message handlers, which run at the game's event rate.
    /// A suppressed update is not lost: it is released by
    /// [`flush_encounter_update`](Self::flush_encounter_update).
    fn emit_encounter_update(&mut self) {
        if self
            .encounter_update_throttle
            .admit(Utc::now().timestamp_millis())
        {
            self.write_encounter_update();
        }
    }

    /// Releases an update the throttle held back. Driven by a timer on the pipe
    /// loop rather than by game events, because the update worth showing most —
    /// the one produced by the killing blow — is precisely the one that arrives
    /// while the window is shut and is followed by no further events.
    pub fn flush_encounter_update(&mut self) {
        if self
            .encounter_update_throttle
            .flush_due(Utc::now().timestamp_millis())
        {
            self.write_encounter_update();
        }
    }

    /// An encounter boundary (save, fail, manual reset). Emits immediately and
    /// re-opens the throttle, so the first update of the next fight is not held
    /// behind the last one of the previous.
    fn publish_encounter_update_now(&mut self) {
        self.encounter_update_throttle.reset();
        self.encounter_update_throttle
            .admit(Utc::now().timestamp_millis());
        self.write_encounter_update();
    }

    /// Everything the overlay needs to draw itself from cold.
    ///
    /// The per-hit paths publish the party only when it changes, so a meter that
    /// mounts or reloads mid-fight has missed those emits and would otherwise
    /// draw four unnamed, uncoloured rows until the party next changed — which,
    /// for a settled party, is never. The meter asks for this once on mount.
    pub fn republish_live_state(&self) {
        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
            let _ = window.emit("encounter-party-update", &self.encounter.player_data);
            let _ = window.emit("encounter-legality-update", &self.last_party_legality);
        }
    }

    fn write_encounter_update(&self) {
        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
    }

    /// Peeks at the first damage event in the log to get the start time of the encounter.
    pub fn start_time(&self) -> i64 {
        if let Some((timestamp, _)) = self.encounter.raw_event_log.first() {
            *timestamp
        } else {
            1
        }
    }

    /// Reparses derived state from a given encounter.
    pub fn from_encounter(encounter: Encounter) -> Self {
        let mut parser = Self {
            encounter,
            ..Default::default()
        };

        parser.reparse();
        parser
    }

    pub fn from_encounter_blob(blob: &[u8]) -> Result<Self> {
        let mut encounter = Encounter::from_blob(blob)?;

        // Repopulate the event log if it's empty.
        encounter.repopulate_event_log();

        Ok(Self::from_encounter(encounter))
    }

    /// Reparses derived state from the current encounter.
    pub fn reparse(&mut self) {
        self.reparse_with_options_window(&[], None, None);
    }

    /// [`Self::reparse`] restricted to a window: the derived state covers only
    /// events inside `[from_ms, up_to_ms]` (both relative to the first event,
    /// `None` = unbounded). Drives the quest-details window scrubber — the
    /// derived start time moves to the window start, so DPS and stun/s are
    /// computed over the window's duration, not the full fight's.
    ///
    /// `target_spans` filters by per-spawn segment (see [`target_selected`])
    /// so individual summons are selectable; empty = everything.
    ///
    /// [`Self::filters`] drops contested damage sources (see [`is_excluded`])
    /// from every derived total. The raw log is untouched, so setting a
    /// different value and reparsing restores them.
    ///
    /// [`Self::selection`] narrows to the selector bar's pinned source and
    /// ability (see [`matches_selection`]), alongside `target_spans` and under
    /// the same rule: it changes whose damage counts, never the window that
    /// damage is measured over.
    pub fn reparse_with_options_window(
        &mut self,
        target_spans: &[TargetSpan],
        from_ms: Option<i64>,
        up_to_ms: Option<i64>,
    ) {
        self.reparse_with_options(target_spans, from_ms, up_to_ms, None);
    }

    /// [`Self::reparse_with_options_window`] plus the analysis view's window
    /// filter: `windows` is a mask of fight-relative spans with the groups
    /// path's exact semantics (`GroupQuery::windows`) — an event is admitted
    /// when its timestamp lies inside ANY span (`from_ms <= t < up_to_ms`),
    /// `Some(&[])` admits nothing, `None` is no mask. The mask never pins the
    /// derived start itself: with no scrub `from`, the window still anchors
    /// on the first ADMITTED hit and ends on the last, so backend rates
    /// measure the hull of admitted damage — for a single masked span that is
    /// the span itself, which is the useful reading; multi-span masks include
    /// the gaps. A caller wanting scrub-window rates pins `from_ms`/`up_to_ms`
    /// as the analysis view's scrub does.
    pub fn reparse_with_options(
        &mut self,
        target_spans: &[TargetSpan],
        from_ms: Option<i64>,
        up_to_ms: Option<i64>,
        windows: Option<&[TimeWindow]>,
    ) {
        let filters = self.filters;
        // Cloned rather than borrowed: the loop below takes `&mut self`.
        let selection = self.selection.clone();
        let log_start = self.start_time();
        // Learned up front from the WHOLE log: most of a marker's hits carry no
        // HP read, so judging it as events stream past would drop only the few
        // that happen to reveal the pool.
        self.phantom_targets = PhantomTargets::learned_from(self.encounter.event_log());
        // The shared spawn segmentation — the SAME `segment_targets_indexed`
        // over the SAME unwindowed raw log that `fetch_encounter_state` uses
        // for `target_entries` and the groups path's assignment, so a
        // SkillTargetState's `segment` indexes the very vector the frontend
        // holds. Computed here (not passed in) because identical inputs give
        // identical output, and the reparse has many callers.
        let (_, target_assignment) =
            segment_targets_indexed(&self.encounter.raw_event_log, log_start);
        self.derived_state = Default::default();
        // `Default` means Stopped, but a reparse says nothing about whether the
        // fight is over — the live path reparses on a filter toggle mid-fight.
        // `ensure_encounter_started` only runs at the START of an encounter, so
        // without this the overlay would render the rest of the fight as
        // finished (frozen clock, latched party).
        self.derived_state.status = self.status;
        let from = from_ms.map(|from| log_start + from);
        match from {
            // An explicit scrub range owns its own start; without one the
            // window opens on the first hit (see `extend_window`), so this is
            // only a provisional value for an encounter that has no damage yet.
            Some(from) => self.derived_state.start_pinned(from),
            None => self.derived_state.start(log_start),
        }
        let cutoff = up_to_ms.map(|up_to| log_start + up_to);

        for (event_index, (timestamp, event)) in self.encounter.event_log().enumerate() {
            if cutoff.is_some_and(|cutoff| *timestamp > cutoff) {
                break;
            }
            // The scrub bounds and the window-filter mask: outside them the
            // event does not exist for this derived state, so every
            // accumulation path downstream (damage, taken, stun, SBA
            // gauge/gains, statuses) narrows identically. Shared with the SBA
            // inference pass below through `admits_event`, so the two can never
            // disagree about which events are real.
            if !admits_event(*timestamp, from, cutoff, windows, log_start) {
                continue;
            }
            // Ahead of the window extension in the DamageEvent arm below: an
            // excluded hit must not stretch the encounter window either, or a
            // fight ending on a filtered Primal Burst would keep that timestamp
            // as its DPS denominator. This also matches the live path, which
            // never reaches `process_damage_event` for an excluded hit and so
            // never moves the window from one.
            if let Message::DamageEvent(event) = event {
                // Incoming (enemy→party) hits have their own accumulation: no
                // window extension (they never anchor or stretch the DPS
                // denominator), no phantom/exclusion filters and no target or
                // ability pins — the victim is a player, not a dropdown target.
                if is_damage_taken_event(event) {
                    self.derived_state
                        .process_damage_taken_event(&self.encounter.player_data, event);
                    continue;
                }
                // Ahead of the excluded-damage note as well: a marker's damage
                // was never real, so it belongs in no total, not even the
                // "excluded" one the user can toggle back on.
                if self.phantom_targets.is_phantom(event) {
                    continue;
                }
                if is_excluded(event, &filters) {
                    self.derived_state.note_excluded_damage(event);
                    continue;
                }
            }
            match event {
                Message::DamageEvent(event) => {
                    // Ahead of the target-selection check, so filtering to one
                    // target narrows WHOSE damage counts without also redefining
                    // the window that damage is measured over. The selector
                    // bar's source/ability pins sit on the same side of this
                    // line for the same reason: pinning one player must not
                    // shorten the fight everyone's DPS is divided by.
                    self.derived_state.extend_window(*timestamp);

                    if target_selected(*timestamp - log_start, event, target_spans)
                        && matches_selection(event, &selection)
                    {
                        let event = remap_dragon_form(&self.encounter.player_data, event);

                        let player_data = self
                            .encounter
                            .player_data
                            .iter()
                            .flatten()
                            .find(|player| player.actor_index == event.source.parent_index);

                        let damage_instance =
                            AdjustedDamageInstance::from_damage_event(&event, player_data)
                                // The event's own position in the raw log —
                                // the dragon-form remap rewrites the SOURCE,
                                // never the target, so the assignment made
                                // over the unremapped log still names this
                                // hit's spawn.
                                .with_target_segment(
                                    target_assignment.get(event_index).copied().flatten(),
                                );

                        self.derived_state
                            .process_damage_event(*timestamp, &damage_instance);
                    }
                }
                // Stun messages carry no target, so target filtering doesn't
                // apply (enemy stun is effectively boss-wide anyway).
                Message::OnPlayerStun(event) => {
                    self.derived_state.process_stun_message(
                        *timestamp,
                        event.actor_index,
                        event.stun_amount as f64,
                    );
                }
                Message::OnPerfectGuardStun(event) => {
                    self.derived_state.process_perfect_guard_stun(
                        *timestamp,
                        &self.encounter.player_data,
                        event.actor_index,
                        event.stun_amount as f64,
                    );
                }
                Message::OnPerfectGuardQuickening(event) => {
                    self.derived_state.process_perfect_guard_quickening(
                        &self.encounter.player_data,
                        event.actor_index,
                    );
                }
                Message::OnStunEffect(event) => {
                    self.derived_state.process_stun_effect(
                        &self.encounter.player_data,
                        event.actor_index,
                        event.stun_amount as f64,
                    );
                }
                // The reparse is what the log viewer reads, so an SBA event
                // dropped here is an SBA tab of zeroes however well the hook
                // captured it. No target/selection gating: the gauge is a
                // property of the player, not of a hit on some enemy.
                Message::OnUpdateSBA(event) => {
                    self.derived_state.process_sba_update(
                        event.actor_index,
                        event.sba_value as f64,
                        event.sba_added as f64,
                    );
                }
                Message::SbaGain(event) => {
                    let cause =
                        event
                            .cause
                            .unwrap_or(protocol::SbaGainCause::Skill(ActionType::Normal(
                                event.action_id,
                            )));
                    self.derived_state.process_sba_gain(
                        event.actor_index,
                        cause,
                        event.amount as f64,
                    );
                }
                Message::OnAttemptSBA(event) => {
                    self.derived_state
                        .process_sba_level(event.actor_index, 800.0);
                }
                Message::OnPerformSBA(event) => {
                    self.derived_state.process_sba_level(event.actor_index, 0.0);
                }
                Message::OnContinueSBAChain(event) => {
                    self.derived_state.process_sba_level(event.actor_index, 0.0);
                }
                _ => {}
            }
        }

        // Gauge the hook could not caption — a remote party member's, which
        // arrives as a bare level from the four-slot poll — gets whatever name
        // the log itself can support. AFTER the loop, for two reasons: the
        // rules join rises against hits on BOTH sides of them in time, and
        // every breakdown row is open by now, so an inferred move gain lands in
        // the row its hit opened instead of waiting on the pending list.
        let inferred = sba_inference::infer(&self.encounter.raw_event_log, &|timestamp| {
            admits_event(timestamp, from, cutoff, windows, log_start)
        });
        for gain in inferred {
            self.derived_state
                .process_sba_gain(gain.actor_index, gain.cause, gain.amount);
        }
    }

    /// Duration of the FULL raw event log (first event → last event, ms, min 1),
    /// independent of any scrub cutoff on the derived state. Anything that walks
    /// the full event log (the quest-details charts) MUST size its buffers from
    /// this — `derived_state.duration()` shrinks under a scrub cutoff and made
    /// the full-log walks index out of bounds.
    pub fn full_log_duration(&self) -> i64 {
        self.encounter
            .raw_event_log
            .last()
            .map(|(timestamp, _)| timestamp - self.start_time())
            .unwrap_or(1)
            .max(1)
    }

    pub fn generate_sba_chart(&self, interval: i64) -> HashMap<u32, Vec<f32>> {
        let start_time = self.start_time();
        let duration = self.full_log_duration();

        let mut chart_values: HashMap<u32, Vec<f32>> = HashMap::new();

        for player in self.derived_state.party.values() {
            chart_values.insert(player.index, vec![0.0; (duration / interval) as usize + 1]);
        }

        let mut last_event_timestamp = start_time;

        for (timestamp, event) in self.encounter.event_log() {
            let last_index = ((last_event_timestamp - start_time) / interval) as usize;
            let index = ((timestamp - start_time) / interval) as usize;

            // Carry over the previous values to the current timeslice.
            if last_index != index && last_index > 0 {
                for (_, entries) in chart_values.iter_mut() {
                    let previous_value = entries[last_index];

                    for i in last_index..=index {
                        if i > 0 && i < entries.len() {
                            entries[i] = previous_value;
                        }
                    }
                }
            }

            if let Some((actor_index, sba_value)) = match event {
                Message::OnUpdateSBA(sba_update_event) => {
                    Some((sba_update_event.actor_index, sba_update_event.sba_value))
                }
                Message::OnAttemptSBA(sba_attempt_event) => {
                    Some((sba_attempt_event.actor_index, 800.0))
                }
                Message::OnPerformSBA(sba_perform_event) => {
                    Some((sba_perform_event.actor_index, 0.0))
                }
                Message::OnContinueSBAChain(sba_continue_event) => {
                    Some((sba_continue_event.actor_index, 0.0))
                }
                _ => None,
            } {
                if let Some(entries) = chart_values.get_mut(&actor_index) {
                    entries[index] = sba_value;
                }
            }

            last_event_timestamp = *timestamp;
        }

        chart_values
    }

    /// Handles the quest-load boundary (v2.0.2: fired by OnLoadQuestHook when the NEXT
    /// quest loads). If the current encounter was in progress — a quest that failed or
    /// was retired emits no result screen, so it is still open here — stop it and save
    /// it under the quest id it was stamped with at ITS OWN load. Only afterwards stamp
    /// the event's quest id, which is the INCOMING quest's (the hooked loader reads
    /// mgr+0xDC8 to look up the quest being loaded, so the slot is already repopulated
    /// when the hook reads it) — stamping first labeled a failed quest's log with the
    /// quest that was just started.
    pub fn on_area_enter_event(&mut self, event: AreaEnterEvent) {
        // Leaving to a normal area ends any active Conflux run (the common case the manager
        // dtor misses: finish a run, exit to town). finalize_active_run saves the final room
        // stamped with its run_id/room_index and writes room_count/duration/completed, so we
        // must NOT then also save it as a normal (run_id-null) encounter below.
        if self.active_run_id.is_some() {
            // Left Conflux for a normal area → run ended, but not via the reward path.
            self.finalize_active_run(false);
        } else if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            self.save_and_emit_encounter();
        } else {
            // Idle: no fight to end (any prior one is already saved). Clear the
            // stale derived state so the emitted Stopped encounter reads empty
            // (total_damage 0) — that's how the overlay tells idle from a result.
            self.reset();
            self.update_status(ParserStatus::Stopped);
        }

        // Fresh encounter: stamp the incoming quest (0 = guarded read failed, keep it
        // unknown rather than storing a bogus id). quest_timer is only ever written by
        // the completion path — clear it so a later failed quest can't inherit it.
        self.encounter.quest_id =
            (event.last_known_quest_id != 0).then_some(event.last_known_quest_id);
        self.encounter.quest_timer = None;
        self.encounter.quest_completed = false;
        self.encounter.reset_player_data();
        // A quest load is the Repeat Quest chain boundary (repeat runs are
        // exactly the ones that load WITHOUT passing here). Cleared after the
        // save above so a chained run cut by this load still joins its chain.
        self.repeat_chain_anchor = None;
        // Same boundary for the standing statuses: the incoming area's own
        // applies fire after this event, and anything still standing from the
        // previous area (a town buff with no observed remove) must not be
        // seeded into the next fight. Repeat Quest chains skip this handler,
        // which is exactly why their persistent buffs survive from run to run.
        self.standing_statuses.clear();

        if let Some(window) = &self.window_handle {
            let _ = window.emit("on-area-enter", &self.derived_state);
        }
    }

    /// Handles one tick of the in-game quest timer — the clock the result
    /// screen reports as the clear time.
    ///
    /// This is display data only; DPS is measured against wall clock. Its value
    /// is that a fight which never reaches a result screen (a wipe, a retire)
    /// still gets an in-game time, where `on_quest_complete_event` alone would
    /// leave it blank.
    ///
    /// It lives on the encounter rather than in the raw event log because the
    /// encounter is what gets serialised — the log would only be re-deriving a
    /// field that is already stored.
    pub fn on_quest_elapsed_time(&mut self, event: QuestElapsedTimeEvent) {
        self.record_in_game_time(event.elapsed_time_in_secs);
    }

    /// Folds in an in-game-time reading, keeping the largest seen. The quest
    /// timer only advances within a quest, so a smaller value means the manager
    /// was reset or torn down (the next quest loading, a mid-teardown read) and
    /// must not overwrite what this encounter was actually fought over.
    fn record_in_game_time(&mut self, elapsed_time_in_secs: u32) {
        if elapsed_time_in_secs == 0
            || self
                .encounter
                .quest_timer
                .is_some_and(|known| known >= elapsed_time_in_secs)
        {
            return;
        }
        self.encounter.quest_timer = Some(elapsed_time_in_secs);
    }

    pub fn on_quest_complete_event(&mut self, event: QuestCompleteEvent) {
        // Rooms and runs have their own save path (on_conflux_room_enter /
        // finalize_active_run), so a completion during an active run must not save the
        // room as a normal quest log — that would double-count it. But the hook only
        // forwards genuine type-5 result screens, so seeing one mid-run means the run
        // was cleared — record that for finalize (the manager dtor rarely fires, and
        // the usual end path — exiting to town — can't tell cleared from abandoned).
        if self.active_run_id.is_some() {
            self.active_run_completed = true;
            return;
        }

        // quest_id 0 means the hook had no quest state (injected mid-quest); keep
        // whatever id we already know instead of overwriting it with "unknown".
        if event.quest_id != 0 {
            self.encounter.quest_id = Some(event.quest_id);
        }
        self.encounter.quest_completed = true;

        // The frozen clear time is the authoritative in-game time for the run.
        // Recorded regardless of the quest id above: an unknown id is no reason
        // to throw away a known clear time.
        self.record_in_game_time(event.elapsed_time_in_secs);

        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);

            if self.has_damage() {
                match self.save_encounter_to_db() {
                    Ok(id) => {
                        // First completed save since the last quest load: the
                        // parent every later run of a Repeat Quest chain
                        // groups under (the save above already stamped the
                        // PREVIOUS anchor, so the parent row itself is NULL).
                        if self.repeat_chain_anchor.is_none() {
                            self.repeat_chain_anchor = id;
                        }
                        if let Some(window) = &self.window_handle {
                            let _ = window.emit("encounter-saved", id);
                        }
                    }
                    Err(e) => {
                        if let Some(window) = &self.window_handle {
                            let _ = window.emit("encounter-saved-error", e.to_string());
                        }
                    }
                }
            }

            self.publish_encounter_update_now();
        }

        // v2.0.2: the area-enter hook (the old between-quest wipe point) no longer
        // installs, so the quest boundary is where stale identities must die — actor
        // indices get reused across quests, and entries carried over would attach the
        // previous quest's names to the next quest's actors. Cleared AFTER the save
        // above (the save reads player_data for the p1..p4 columns); every player's
        // identity is re-announced with their damage, so the next quest repopulates.
        self.encounter.reset_player_data();

        // A Repeat Quest chain never revisits the quest-load boundary, so per-run
        // state must also die here: the next chained run records its own clear
        // time (keep-the-max made nine 109–137s clears all store a stale 142),
        // and a wipe on a later run must not read as completed.
        self.encounter.quest_timer = None;
        self.encounter.quest_completed = false;
    }

    /// A training session started, which also tears down the previous one.
    /// Closes and saves any run that has damage, then opens a fresh encounter.
    ///
    /// Deliberately NOT gated on a quest id or the quest-complete flag: training
    /// never runs `on_load_quest_state`, so both are stale from the previous
    /// quest and would silently suppress every training save.
    pub fn on_trial_start_event(&mut self) {
        self.on_trial_end_event();
        // Training loads without a quest load, but it is no repeat of the
        // quest completed before it.
        self.repeat_chain_anchor = None;
        self.reset();
    }

    /// The player quit training. Closes and saves the run.
    ///
    /// The training room has no quest flow object, so this (and the start
    /// teardown above) is the only boundary that can ever close a training
    /// encounter. The in-progress gate makes the second of the quit hook's two
    /// per-quit calls inert.
    pub fn on_trial_end_event(&mut self) {
        if self.status != ParserStatus::InProgress {
            return;
        }

        self.update_status(ParserStatus::Stopped);
        self.save_and_emit_encounter();

        self.publish_encounter_update_now();

        // Same rationale as the quest boundaries: actor indices are reused across
        // sessions, so stale identities must die here (after the save above).
        self.encounter.reset_player_data();
    }

    /// Handles the retire/fail boundary (v2.0.2): fired the moment the player
    /// confirms retire/abandon (the game's retire-select flag hook) — quests that
    /// end this way show no result screen, so without this the log sat open until
    /// the next quest load. Saves the in-progress encounter as not-completed under
    /// the quest id stamped at its own load (the event's id is only a fallback for
    /// mid-quest injection). The quest-load boundary stays as the backstop and is
    /// a no-op afterwards (status is already Stopped).
    pub fn on_quest_fail_event(&mut self, event: protocol::OnQuestFailEvent) {
        // Conflux rooms/runs have their own save boundaries (room-enter /
        // finalize_active_run); a mid-run retire must not save a normal log too.
        if self.active_run_id.is_some() {
            return;
        }

        if self.encounter.quest_id.is_none() && event.quest_id != 0 {
            self.encounter.quest_id = Some(event.quest_id);
        }

        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            self.save_and_emit_encounter();

            self.publish_encounter_update_now();
        }

        // Same rationale as the quest-complete boundary: actor indices are reused
        // across quests, so stale identities must die here (after the save above).
        self.encounter.reset_player_data();

        // Quest boundary: the same per-run clears as the completion path. The
        // wipe/retire also ends any Repeat Quest chain — continuing from here
        // goes through a full quest load.
        self.encounter.quest_timer = None;
        self.encounter.quest_completed = false;
        self.repeat_chain_anchor = None;
    }

    /// Starts the encounter (discard stale state, set the start time, mark
    /// InProgress) if it isn't already running. The encounter's opening event
    /// is not necessarily a damage event — a dedicated guarder can perfect-guard
    /// the boss's first attack before anyone deals damage — so every entry point
    /// that records into the live encounter must call this before pushing.
    /// Otherwise the first damage event's `reset()` would wipe an earlier guard
    /// from both the meter and the raw event log (unrecoverable on reparse).
    fn ensure_encounter_started(&mut self, now: i64) {
        if self.status != ParserStatus::InProgress {
            self.reset();
            self.derived_state.start(now);
            self.update_status(ParserStatus::InProgress);
            // Seed the fight with every status standing at its opening event —
            // quest-start buffs land before anyone deals damage, and on a
            // Repeat Quest chain the sigil passives are never re-applied at
            // all, so without this they exist in no encounter's log. Stamped
            // `now`: "active when the fight began" is the honest timestamp the
            // interval assembly can anchor an uptime on.
            for event in self.standing_statuses.values() {
                self.encounter
                    .push_event(now, Message::StatusApply(event.clone()));
            }
        }
    }

    // Called when a damage event is received from the game.
    pub fn on_damage_event(&mut self, event: DamageEvent) {
        let now = Utc::now().timestamp_millis();

        if Self::should_ignore_damage_event(&event) {
            return;
        }

        // If this is the first event of the encounter, start it.
        self.ensure_encounter_started(now);

        self.encounter
            .push_event(now, Message::DamageEvent(event.clone()));

        // An incoming (enemy→party) hit: recorded above like any other event,
        // then routed to the taken accumulation. The dealt pipeline below —
        // phantom learning, exclusion filters, DPS windowing — is about hits
        // ON enemies and must never see it.
        if is_damage_taken_event(&event) {
            self.derived_state
                .process_damage_taken_event(&self.encounter.player_data, &event);
            self.emit_encounter_update();
            return;
        }

        // Recorded above, counted nowhere — same contract as the filters below.
        // Live can only recognise a marker from its first HP-bearing hit
        // onward, so a few earlier hits may sit in the overlay's running total;
        // the saved log is reparsed from the raw events and comes out exact.
        self.phantom_targets.observe(&event);
        if self.phantom_targets.is_phantom(&event) {
            return;
        }

        // Recorded above, counted nowhere: the raw log is the source of truth,
        // so turning the setting on and reparsing brings this hit back. The
        // return also keeps it out of `derived_state.end_time`, matching the
        // reparse path, and suppresses the `encounter-update` emit below —
        // nothing the frontend renders changed.
        if is_excluded(&event, &self.filters) {
            self.derived_state.note_excluded_damage(&event);
            return;
        }

        let event = remap_dragon_form(&self.encounter.player_data, &event);

        let player_data = self
            .encounter
            .player_data
            .iter()
            .flatten()
            .find(|player| player.actor_index == event.source.parent_index);

        let damage_instance = AdjustedDamageInstance::from_damage_event(&event, player_data);

        self.derived_state
            .process_damage_event(now, &damage_instance);

        self.emit_encounter_update();
    }

    pub fn on_player_load_event(&mut self, event: PlayerLoadEvent) {
        let character_type = CharacterType::from_hash(event.character_type);

        // Id's transformation resolves to the Id player (or is ignored when its
        // slot belongs to someone else) — see slot_character_for_identity.
        let Some(character_type) = slot_character_for_identity(
            &self.encounter.player_data,
            character_type,
            event.party_index,
        ) else {
            return;
        };

        let sigils = event
            .sigils
            .into_iter()
            .map(|sigil| Sigil {
                first_trait_id: sigil.first_trait_id,
                first_trait_level: sigil.first_trait_level,
                second_trait_id: sigil.second_trait_id,
                second_trait_level: sigil.second_trait_level,
                sigil_id: sigil.sigil_id,
                equipped_character: sigil.equipped_character,
                sigil_level: sigil.sigil_level,
                acquisition_count: sigil.acquisition_count,
                notification_enum: sigil.notification_enum,
            })
            .collect();

        let player_data = PlayerData {
            actor_index: event.actor_index,
            display_name: event.display_name.to_string_lossy().to_string(),
            character_name: event.character_name.to_string_lossy().to_string(),
            is_online: event.is_online,
            character_type,
            sigils,
            summons: Vec::new(),
            abilities: Vec::new(),
            weapon_key: String::new(),
            master_level: 0,
            skillboard: Vec::new(),
            stats: None,
            weapon_state: None,
            cap_up_normal: None,
            cap_up_skill: None,
            cap_up_sba: None,
            weapon_info: Some(event.weapon_info.into()),
            overmastery_info: Some(event.overmastery_info.into()),
            player_stats: Some(event.player_stats.into()),
        };

        self.insert_player_data(player_data, event.party_index);
    }

    /// Handles the game 2.0.2 identity-only event: name + party slot, without the
    /// equipment/stats the full player_load carries. Merges into any existing slot
    /// for this actor (preserving equipment if it was ever populated) or creates a
    /// new identity-only entry, so same-character players stay distinct and online
    /// players show their real name instead of `[Guest]`.
    pub fn on_player_identity_event(&mut self, event: PlayerIdentityEvent) {
        let character_type = CharacterType::from_hash(event.character_type);

        // Id's transformation resolves to the Id player (or is ignored when its
        // slot belongs to someone else) — see slot_character_for_identity.
        let Some(character_type) = slot_character_for_identity(
            &self.encounter.player_data,
            character_type,
            event.party_index,
        ) else {
            return;
        };

        let mut player_data = self
            .encounter
            .player_data
            .iter()
            .flatten()
            .find(|player| player.actor_index == event.actor_index)
            .cloned()
            .unwrap_or(PlayerData {
                actor_index: event.actor_index,
                display_name: String::new(),
                character_name: String::new(),
                character_type,
                sigils: Vec::new(),
                summons: Vec::new(),
                abilities: Vec::new(),
                weapon_key: String::new(),
                master_level: 0,
                skillboard: Vec::new(),
                stats: None,
                weapon_state: None,
                cap_up_normal: None,
                cap_up_skill: None,
                cap_up_sba: None,
                is_online: event.is_online,
                weapon_info: None,
                overmastery_info: None,
                player_stats: None,
            });

        player_data.display_name = event.display_name.to_string_lossy().to_string();
        player_data.character_name = event.character_name.to_string_lossy().to_string();
        player_data.character_type = character_type;
        player_data.is_online = event.is_online;

        // Sigils recovered from the identity snapshot. Only overwrite when the event
        // carries some, so an identity refresh without sigil data (or an older hook)
        // can't wipe equipment learned from a full player-load event.
        if !event.sigils.is_empty() {
            player_data.sigils = event
                .sigils
                .into_iter()
                .map(|sigil| Sigil {
                    first_trait_id: sigil.first_trait_id,
                    first_trait_level: sigil.first_trait_level,
                    second_trait_id: sigil.second_trait_id,
                    second_trait_level: sigil.second_trait_level,
                    sigil_id: sigil.sigil_id,
                    equipped_character: sigil.equipped_character,
                    sigil_level: sigil.sigil_level,
                    acquisition_count: sigil.acquisition_count,
                    notification_enum: sigil.notification_enum,
                })
                .collect();
        }

        // Same only-overwrite-when-present rule as sigils: an identity refresh
        // without summon data must not wipe a previously learned set.
        if !event.summons.is_empty() {
            player_data.summons = event.summons.into_iter().map(Into::into).collect();
        }

        // Overmasteries: the hook reads the record's inline block (in-quest, with
        // computed `value`) and falls back to the town loadout pairs (`value` 0.0,
        // rendered as "<name> (Lvl. N)"). Keep the last non-empty set (mirrors
        // sigils) so a sparse refresh can't wipe a learned set.
        if !event.overmasteries.is_empty() {
            player_data.overmastery_info = Some(OvermasteryInfo {
                overmasteries: event.overmasteries.into_iter().map(Into::into).collect(),
            });
        }

        // Same only-overwrite-when-present rule for the remaining equipment
        // fields, so a half-populated refresh (e.g. before the save finishes
        // loading, or a remote player with no local save data) can't wipe
        // previously learned values.
        if !event.abilities.is_empty() {
            player_data.abilities = event.abilities;
        }
        if !event.weapon_key.is_empty() {
            player_data.weapon_key = event.weapon_key;
        }
        if event.master_level != 0 {
            player_data.master_level = event.master_level;
        }
        if !event.skillboard.is_empty() {
            player_data.skillboard = event.skillboard;
        }
        if let Some(stats) = event.stats {
            player_data.stats = Some(stats.into());
        }
        if let Some(weapon_state) = event.weapon_state {
            let fresh: WeaponState = weapon_state.into();
            player_data.weapon_state = Some(match player_data.weapon_state.take() {
                Some(known) => merge_weapon_state(known, fresh),
                None => fresh,
            });
        }
        // Same only-overwrite-when-present rule. Each class independently: a
        // record read that resolved two of the three must not blank the third.
        if let Some(cap_up) = event.cap_up_normal {
            player_data.cap_up_normal = Some(cap_up);
        }
        if let Some(cap_up) = event.cap_up_skill {
            player_data.cap_up_skill = Some(cap_up);
        }
        if let Some(cap_up) = event.cap_up_sba {
            player_data.cap_up_sba = Some(cap_up);
        }

        // Character level, also town-loadout-only. Fold it into player_stats without
        // clobbering a fuller stats block a PlayerLoadEvent may have set: update just
        // the level, defaulting the still-unrecovered v2.0.2 stat fields to 0.
        if event.player_level != 0 {
            let mut stats = player_data.player_stats.take().unwrap_or(PlayerStats {
                level: 0,
                total_hp: 0,
                total_attack: 0,
                stun_power: 0.0,
                critical_rate: 0.0,
                total_power: 0,
            });
            stats.level = event.player_level;
            player_data.player_stats = Some(stats);
        }

        self.insert_player_data(player_data, event.party_index);
    }

    /// Inserts or updates a player in the encounter's 4-slot array at its party slot.
    /// Shared by the full player_load path and the identity-only path.
    ///
    /// v2.0.2: `actor_index` is a pointer-like value (no meaningful order) and the
    /// LOCAL player is flagged `is_online` inside a lobby, so the old actor-index
    /// ordering heuristics mis-slotted or dropped players. The identity snapshot's
    /// party slot (0..=3, a verified surviving field) is the stable position: array
    /// position == party slot.
    fn insert_player_data(&mut self, player_data: PlayerData, party_index: u8) {
        let Some(slot) = self.encounter.player_data.get_mut(party_index as usize) else {
            // 0xFF placeholder or corrupt slot — never clobber a real slot with it.
            return;
        };
        // The identity path publishes on EVERY damage hit (`hooks/damage.rs`
        // sends a `PlayerIdentityEvent` for each hit's source actor), so this
        // runs at combat rate, not once per equipment snapshot. A settled party
        // is identical on all of them, so both the audit and the two emits are
        // gated on a real change.
        //
        // The emits used to be ungated, to guarantee that a meter mounting
        // mid-fight learned the party at all — `useMeter` had no fetch for it.
        // That guarantee now comes from [`Parser::republish_live_state`], which
        // the meter asks for once on mount, instead of from re-serialising four
        // whole equipment sets on every hit for the life of the quest.
        //
        // [`live_emit::snapshot_changed`] rather than `!=` because the payload
        // holds `f32`s read from game memory: NaN is never equal to itself, so
        // a derived comparison would report a change on every hit forever and
        // quietly restore the cost this gate exists to remove.
        if !live_emit::snapshot_changed(slot.as_ref(), &player_data) {
            return;
        }

        *slot = Some(player_data);
        // A live fight has no stored row to read verdicts from, so the meter's
        // colouring is derived here.
        self.last_party_legality = self.party_legality();

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-party-update", &self.encounter.player_data);
            let _ = window.emit("encounter-legality-update", &self.last_party_legality);
        }
    }

    /// Findings per party slot, in `player_data` order. Empty vectors for
    /// absent or clean players, so a caller can index by slot without
    /// tracking which slots exist.
    pub fn party_legality(&self) -> [Vec<crate::legality::Finding>; 4] {
        std::array::from_fn(|slot| {
            self.encounter.player_data[slot]
                .as_ref()
                .map(crate::legality::audit_player)
                .unwrap_or_default()
        })
    }

    /// Handles one per-hit stun message from the network stun-apply hook — the
    /// online stun source (the damage-event delta path reads 0 in lobbies).
    pub fn on_player_stun(&mut self, event: OnPlayerStunEvent) {
        let now = Utc::now().timestamp_millis();
        self.encounter
            .push_event(now, Message::OnPlayerStun(event.clone()));

        self.derived_state
            .process_stun_message(now, event.actor_index, event.stun_amount as f64);

        self.emit_encounter_update();
    }

    /// Handles one Perfect Guard stun capture (source-side accumulator delta on
    /// the enemy's guarded attack, attributed to the guarding player).
    pub fn on_perfect_guard_stun(&mut self, event: OnPlayerStunEvent) {
        let now = Utc::now().timestamp_millis();
        // A guard can be the encounter's opening event (see ensure_encounter_started).
        self.ensure_encounter_started(now);
        self.encounter
            .push_event(now, Message::OnPerfectGuardStun(event.clone()));

        self.derived_state.process_perfect_guard_stun(
            now,
            &self.encounter.player_data,
            event.actor_index,
            event.stun_amount as f64,
        );

        self.emit_encounter_update();
    }

    /// Handles one non-guard stun-effect proc (Eugen's sticky grenade): a
    /// source-side accumulator delta attributed to the applying player, surfaced
    /// as their own StunEffect row (not Perfect Guard).
    pub fn on_stun_effect(&mut self, event: OnPlayerStunEvent) {
        let now = Utc::now().timestamp_millis();
        // A stun proc can be the encounter's opening event (see ensure_encounter_started).
        self.ensure_encounter_started(now);
        self.encounter
            .push_event(now, Message::OnStunEffect(event.clone()));

        self.derived_state.process_stun_effect(
            &self.encounter.player_data,
            event.actor_index,
            event.stun_amount as f64,
        );

        self.emit_encounter_update();
    }

    /// Records one status effect landing on an actor.
    ///
    /// Kept in the raw log only: uptime is assembled from apply/remove pairs on
    /// read (see [`assemble_intervals`]), so nothing here has to hold open
    /// intervals across a reparse.
    ///
    /// Recorded ONLY inside a running encounter, and deliberately never opens
    /// one. Statuses fire constantly outside combat — party buffs on load,
    /// food, regen in town — so starting a fight on one would fill the log with
    /// empty quests. An apply that lands OUTSIDE an encounter is not lost,
    /// though: it goes into [`Self::standing_statuses`], and the next
    /// `ensure_encounter_started` seeds it into that encounter's log — which is
    /// how quest-start buffs (Guts, Autorevive, the sigil passives), applied
    /// seconds before anyone deals damage, make it into the fight at all.
    pub fn on_status_apply(&mut self, event: protocol::StatusApplyEvent) {
        // Standing state is maintained unconditionally — it is the record of
        // what is active NOW, encounter or no encounter.
        self.standing_statuses.insert(
            (event.actor_index, event.status_id, event.ability_id),
            event.clone(),
        );
        if self.status != ParserStatus::InProgress {
            return;
        }
        let now = Utc::now().timestamp_millis();
        self.encounter.push_event(now, Message::StatusApply(event));
    }

    /// Records one status effect ending. Same in-fight rule as
    /// [`Self::on_status_apply`]: a buff expiring in town belongs to no
    /// encounter, and recording it would attach it to the NEXT one — but it
    /// always leaves the standing map, so a lapsed buff is never seeded into
    /// the next fight.
    pub fn on_status_remove(&mut self, event: protocol::StatusRemoveEvent) {
        self.standing_statuses
            .remove(&(event.actor_index, event.status_id, event.ability_id));
        if self.status != ParserStatus::InProgress {
            return;
        }
        let now = Utc::now().timestamp_millis();
        self.encounter.push_event(now, Message::StatusRemove(event));
    }

    /// Records a Link Time transition. Raw log only (the chart windows are
    /// assembled on read, see `assemble_chart_windows`), and only inside a
    /// running encounter — link time cannot exist outside a fight, and the
    /// transition latch in the hook means a stray pre-fight `false` carries
    /// no information.
    pub fn on_link_time(&mut self, event: protocol::LinkTimeEvent) {
        if self.status != ParserStatus::InProgress {
            return;
        }
        let now = Utc::now().timestamp_millis();
        self.encounter.push_event(now, Message::LinkTime(event));
    }

    /// Records an enemy mode transition (Normal / Overdrive / Break). Same
    /// in-fight rule as [`Self::on_link_time`].
    pub fn on_enemy_mode(&mut self, event: protocol::EnemyModeEvent) {
        if self.status != ParserStatus::InProgress {
            return;
        }
        let now = Utc::now().timestamp_millis();
        self.encounter.push_event(now, Message::EnemyMode(event));
    }

    /// Handles one guarded-Quickening marker (The World): counts the guard for
    /// the player, nothing else.
    pub fn on_perfect_guard_quickening(&mut self, event: OnPlayerStunEvent) {
        let now = Utc::now().timestamp_millis();
        // A guard can be the encounter's opening event (see ensure_encounter_started).
        self.ensure_encounter_started(now);
        self.encounter
            .push_event(now, Message::OnPerfectGuardQuickening(event.clone()));

        self.derived_state
            .process_perfect_guard_quickening(&self.encounter.player_data, event.actor_index);

        self.emit_encounter_update();
    }

    /// Handles setting the SBA gauge value for a player
    pub fn on_sba_update(&mut self, event: OnUpdateSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnUpdateSBA(event.clone()),
        );

        self.derived_state.process_sba_update(
            event.actor_index,
            event.sba_value as f64,
            event.sba_added as f64,
        );

        self.emit_encounter_update();
    }

    /// Handles one attributed SBA gain (local player only — see `SbaGainEvent`).
    pub fn on_sba_gain(&mut self, event: protocol::SbaGainEvent) {
        let now = Utc::now().timestamp_millis();
        // A gain can be the encounter's opening event: the `QuestStart` grant
        // fires at quest load, before anyone has dealt damage, and without
        // this the first damage event's `reset()` erased it from the raw log
        // (unrecoverable on reparse). Gains only fire in-quest — unlike the
        // gauge POLL, which ticks in town and must never open an encounter.
        self.ensure_encounter_started(now);
        self.encounter
            .push_event(now, Message::SbaGain(event.clone()));

        // The cause is resolved in the HOOK, where the gauge rise, the parked
        // hit and the update's own flag arguments are all in scope. `None` only
        // appears in logs stored before causes existed, and means what it used
        // to: the hit's own Normal action.
        let cause = event
            .cause
            .unwrap_or(protocol::SbaGainCause::Skill(ActionType::Normal(
                event.action_id,
            )));
        self.derived_state
            .process_sba_gain(event.actor_index, cause, event.amount as f64);

        self.emit_encounter_update();
    }

    pub fn on_sba_attempt(&mut self, event: OnAttemptSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnAttemptSBA(event.clone()),
        );

        self.derived_state
            .process_sba_level(event.actor_index, 800.0);

        self.emit_encounter_update();
    }

    pub fn on_sba_perform(&mut self, event: OnPerformSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnPerformSBA(event.clone()),
        );

        self.derived_state.process_sba_level(event.actor_index, 0.0);

        self.emit_encounter_update();
    }

    /// @TODO(false): Note that this event only fires for the local player.
    pub fn on_continue_sba_chain(&mut self, event: OnContinueSBAChainEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnContinueSBAChain(event.clone()),
        );

        self.derived_state.process_sba_level(event.actor_index, 0.0);

        self.emit_encounter_update();
    }

    pub fn on_death_event(&mut self, event: OnDeathEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnDeathEvent(event.clone()),
        );
    }

    /// Manual reset requested from the meter UI: discard the current encounter
    /// without saving it and go back to waiting for the next damage event.
    pub fn on_manual_reset(&mut self) {
        self.reset();
        self.update_status(ParserStatus::Stopped);

        self.publish_encounter_update_now();
    }

    fn reset(&mut self) {
        // player_data deliberately survives this reset: the hook emits each player's
        // identity BEFORE their damage event, so wiping here would drop the identity
        // that accompanies the encounter's opening hit. Stale identities are cleared
        // at the quest boundary instead (on_quest_complete_event / on_area_enter_event).
        self.encounter.raw_event_log.clear();
        self.encounter.raw_event_log.shrink_to_fit();
        self.derived_state = Default::default();
    }

    fn update_status(&mut self, new_status: ParserStatus) {
        self.status = new_status;
        self.derived_state.status = new_status;
    }

    fn has_damage(&self) -> bool {
        self.derived_state.total_damage > 0
    }

    /// Persist the current encounter (if it has damage) and notify the frontend of
    /// the result via the `app` handle. Shared by the normal-area, game-disconnect,
    /// and Conflux-room-enter save points, which all end an in-progress normal
    /// encounter the same way. Does not touch parser status — callers own that.
    fn save_and_emit_encounter(&mut self) {
        if !self.has_damage() {
            return;
        }
        match self.save_encounter_to_db() {
            Ok(id) => {
                if let Some(app) = &self.app {
                    let _ = app.emit_all("encounter-saved", id);
                }
            }
            Err(e) => {
                if let Some(app) = &self.app {
                    let _ = app.emit_all("encounter-saved-error", e.to_string());
                }
            }
        }
    }

    // Checks if the damage event should be ignored for the purposes of parsing.
    // `pub(crate)` so the Debug tab's synthetic scenarios can assert against the
    // real filter instead of restating its conditions (see `debug_events`).
    pub(crate) fn should_ignore_damage_event(event: &DamageEvent) -> bool {
        let character_type = CharacterType::from_hash(event.source.parent_actor_type);

        if event.damage <= 0 {
            return true;
        }

        // Enemy→party hits are the damage-taken stream: recorded and derived,
        // never dropped for their unknown source.
        if is_damage_taken_event(event) {
            return false;
        }

        // Hand-listed non-enemy actors (Eugen's Grenade, skill-spawned markers).
        // The learned tiny-HP rule can't run here — it needs an HP read this
        // event may not carry — so it is applied on the derive path instead,
        // which is also what makes it retroactive for already-recorded logs.
        if is_excluded_target_type(event) {
            return true;
        }

        // If the parent actor type is unknown (not tied to a player character), then ignore it.
        // This usually happens if the damage instance is tied to an enemy/monster.
        if matches!(character_type, CharacterType::Unknown(_)) {
            return true;
        }

        false
    }

    /// The game process closed (named pipe disconnected). The parser instance is
    /// dropped right after, so anything unsaved here is lost. An abandoned quest
    /// (retire → town → quit) emits NO result screen and never reaches another
    /// quest-load boundary — this is its only save point.
    pub fn on_game_disconnect(&mut self) {
        if self.active_run_id.is_some() {
            // Mid-Conflux quit: saves the in-progress room and closes the run row.
            self.finalize_active_run(false);
            return;
        }

        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            self.save_and_emit_encounter();
        }
    }

    /// Opens a new Conflux run: insert a runs row, reset per-run accumulators, and
    /// remember the manager pointer that identifies this run.
    fn start_conflux_run(&mut self, manager_ptr: u64) {
        let now = Utc::now().timestamp_millis();
        self.active_room_index = 0;
        self.active_run_buffs.clear();
        self.active_run_start = now;
        self.active_run_manager = manager_ptr;
        self.active_run_completed = false;
        if let Some(conn) = &self.db {
            match insert_run(conn, now) {
                Ok(id) => self.active_run_id = Some(id),
                Err(_) => self.active_run_id = None,
            }
        }
        // Let an open Conflux tab pick up the new (in-progress) run row immediately.
        if let (Some(app), Some(id)) = (&self.app, self.active_run_id) {
            let _ = app.emit_all("conflux-run-saved", id);
        }
    }

    /// A Conflux room loads. The reception dispatcher fires per ROOM, so this is the
    /// room boundary: cut off + save the previous room (stamped with run id + room
    /// index), then start the next room's encounter fresh (mirrors on_area_enter_event).
    ///
    /// Run identity comes from `manager_ptr`: the first room, or any room whose manager
    /// differs from the active run's, OPENS a new run (the previous run, if any, is
    /// finalized first — a run can end by the next run starting even if the dtor was
    /// missed).
    pub fn on_conflux_room_enter(&mut self, event: ConfluxRoomEnterEvent) {
        let is_new_run =
            self.active_run_id.is_none() || self.active_run_manager != event.manager_ptr;

        if is_new_run {
            // A leftover NORMAL encounter can still be in progress here: a quest that
            // ended with no result screen (fail/retire) followed straight by a Conflux
            // run. The hook's quest-load boundary cut is deliberately suppressed on
            // room loads (it would finalize the run every room), so save the leftover
            // as a normal log now — otherwise its damage merges into room 1.
            if self.active_run_id.is_none() && self.status == ParserStatus::InProgress {
                self.update_status(ParserStatus::Stopped);
                self.save_and_emit_encounter();
            }
            // Conflux room loads suppress the quest-load boundary, so end any
            // Repeat Quest chain here instead (after the leftover save above,
            // which may itself belong to that chain).
            self.repeat_chain_anchor = None;

            // Close out any prior run before opening the new one (defensive: normally the
            // manager dtor already finalized it). Superseded by a new run → not "completed".
            if self.active_run_id.is_some() {
                self.finalize_active_run(false);
            }
            self.start_conflux_run(event.manager_ptr);
        } else {
            // Same run, next room: save the room we were just recording, then advance the
            // index. The index advances for EVERY room transition, not only damage-bearing
            // ones — a room where the player dealt no recorded damage (shop/rest/skipped)
            // produces no saved room row, but must still consume its own index so its
            // buffs (tagged with `active_room_index` in on_conflux_buff_acquired) don't
            // bleed onto the next room that DOES get saved.
            if self.status == ParserStatus::InProgress {
                self.update_status(ParserStatus::Stopped);
                if self.has_damage() {
                    let saved = self.save_room_to_db();
                    // Refresh an open Conflux tab so the room shows up mid-run, not
                    // only at run end.
                    if saved.is_ok() {
                        if let (Some(app), Some(run_id)) = (&self.app, self.active_run_id) {
                            let _ = app.emit_all("conflux-run-saved", run_id);
                        }
                    }
                }
                self.active_room_index += 1;
            }
        }

        self.encounter.quest_id = if event.quest_id != 0 {
            Some(event.quest_id)
        } else {
            None
        };
        self.encounter.quest_completed = false;
        self.encounter.reset_player_data();

        if let Some(window) = &self.window_handle {
            let _ = window.emit("on-area-enter", &self.derived_state);
        }
    }

    /// A Conflux buff installs. Accumulate under the active room index, deduped.
    pub fn on_conflux_buff_acquired(&mut self, event: ConfluxBuffAcquiredEvent) {
        if self.active_run_id.is_none() {
            return;
        }
        let room = self.active_room_index;
        let entry = self
            .active_run_buffs
            .iter_mut()
            .find(|b| b.room_index == room);
        match entry {
            Some(delta) => {
                if !delta.buff_ids.contains(&event.buff_id) {
                    delta.buff_ids.push(event.buff_id);
                }
            }
            None => self.active_run_buffs.push(ConfluxBuffDelta {
                room_index: room,
                buff_ids: vec![event.buff_id],
            }),
        }
    }

    /// The Conflux run ends (manager destroyed). Finalizes the active run.
    ///
    /// We deliberately do NOT require `event.manager_ptr == active_run_manager`: live logs
    /// show the `EndlessModeQuestManager` dtor is unreliable — it fires rarely (≈once/session)
    /// and when it does the freed pointer often does not match the manager the reception
    /// dispatcher reported for the active run (heap churn / a different manager object being
    /// torn down). Since only one run is ever active at a time, any manager-dtor is treated as
    /// "the current run ended". The primary boundary is still finalize-on-next-start
    /// (`on_conflux_room_enter`); this dtor path is the secondary end signal.
    pub fn on_conflux_run_end(&mut self, _event: ConfluxRunEndEvent) {
        if self.active_run_id.is_none() {
            return;
        }
        // The dtor is the run's natural end (reward/exit reached) → completed.
        self.finalize_active_run(true);
    }

    /// Saves the final in-progress room (if any) and finalizes the active run's row,
    /// then clears run state and notifies the frontend. Shared by the dtor path and the
    /// "next run started"/"left to a normal area" defensive paths.
    ///
    /// `completed` records whether the run reached its natural end vs. was ended by leaving
    /// or being superseded by a new run — it drives the ✓ shown in the Conflux tab. Only the
    /// dtor path passes `true`, but a type-5 result screen observed mid-run
    /// (`active_run_completed`) also marks the run cleared regardless of the end path.
    fn finalize_active_run(&mut self, completed: bool) {
        let Some(run_id) = self.active_run_id else {
            return;
        };

        // A type-5 result screen observed during the run is a clear, whichever path
        // ended the run (town exit, supersession, disconnect).
        let completed = completed || self.active_run_completed;

        let mut room_count = self.active_room_index;
        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);
            if self.has_damage() {
                let _ = self.save_room_to_db();
                room_count += 1;
            }
        }

        let now = Utc::now().timestamp_millis();
        let duration = (now - self.active_run_start).max(1);
        if let Some(conn) = &self.db {
            let _ = finalize_run(
                conn,
                run_id,
                now,
                duration,
                room_count,
                completed,
                &self.active_run_buffs,
            );
        }

        self.active_run_id = None;
        self.active_run_manager = 0;
        self.active_run_buffs.clear();
        self.active_room_index = 0;
        self.active_run_completed = false;

        if let Some(app) = &self.app {
            let _ = app.emit_all("conflux-run-saved", run_id);
        }
    }

    /// Saves the current encounter as a room row (like save_encounter_to_db, but
    /// stamped with run_id/room_index/total_damage). Returns the inserted log id.
    fn save_room_to_db(&mut self) -> Result<Option<i64>> {
        let run_id = self.active_run_id;
        let room_index = self.active_room_index;
        self.save_encounter_to_db_inner(run_id, Some(room_index))
    }

    fn save_encounter_to_db(&mut self) -> Result<Option<i64>> {
        self.save_encounter_to_db_inner(None, None)
    }

    fn save_encounter_to_db_inner(
        &mut self,
        run_id: Option<i64>,
        room_index: Option<u32>,
    ) -> Result<Option<i64>> {
        let duration_in_millis = self.derived_state.duration();
        let start_datetime = self.derived_state.utc_start_time()?;
        let total_damage = self.derived_state.total_damage as i64;

        let primary_target = self
            .derived_state
            .get_primary_target()
            .map(|target| target.raw_target_type);

        // Sir Barrold should never save quest ID, as it could be stale.
        if primary_target == Some(0xA379AC65) {
            self.encounter.quest_id = None;
            self.encounter.quest_timer = None;
        }

        // Conflux rooms group by run_id/room_index instead; only normal quest
        // rows join a Repeat Quest chain.
        let repeat_group = if run_id.is_none() {
            self.repeat_chain_anchor
        } else {
            None
        };

        let encounter_data = self.encounter.to_blob()?;

        let p1 = self.encounter.player_data[0].as_ref();
        let p2 = self.encounter.player_data[1].as_ref();
        let p3 = self.encounter.player_data[2].as_ref();
        let p4 = self.encounter.player_data[3].as_ref();

        if let Some(conn) = &mut self.db {
            conn.execute(
                r#"INSERT INTO logs (
                        name,
                        time,
                        duration,
                        data,
                        version,
                        primary_target,
                        p1_name,
                        p1_type,
                        p2_name,
                        p2_type,
                        p3_name,
                        p3_type,
                        p4_name,
                        p4_type,
                        quest_id,
                        quest_elapsed_time,
                        quest_completed,
                        run_id,
                        room_index,
                        total_damage,
                        legality_rules_version,
                        repeat_group
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                params![
                    "",
                    start_datetime.timestamp_millis(),
                    duration_in_millis,
                    &encounter_data,
                    1,
                    primary_target,
                    p1.map(|p| p.display_name.as_str()),
                    p1.map(|p| p.character_type.to_string()),
                    p2.map(|p| p.display_name.as_str()),
                    p2.map(|p| p.character_type.to_string()),
                    p3.map(|p| p.display_name.as_str()),
                    p3.map(|p| p.character_type.to_string()),
                    p4.map(|p| p.display_name.as_str()),
                    p4.map(|p| p.character_type.to_string()),
                    self.encounter.quest_id,
                    self.encounter.quest_timer,
                    self.encounter.quest_completed,
                    run_id,
                    room_index,
                    total_damage,
                    // Stamped here rather than left for the startup sweep: an
                    // unstamped log reads as stale, so every fresh save would
                    // be re-audited on the next launch and the write below
                    // would be wasted work.
                    crate::legality::RULES_VERSION,
                    repeat_group
                ],
            )?;

            let id = conn.last_insert_rowid();

            // Audit while the equipment is in hand. Re-running the rules later
            // means decompressing and reparsing this blob again, which is the
            // whole cost the stored findings exist to avoid.
            //
            // Asked with the very timestamp stored as `time` above, so this
            // agrees with the sweep by construction rather than by coincidence.
            if crate::legality::should_audit(start_datetime.timestamp_millis()) {
                self.encounter.write_legality_findings(conn, id)?;
            }

            return Ok(Some(id));
        }

        Ok(None)
    }
}

#[cfg(test)]
mod legality_save_tests {
    use super::*;

    /// Saving an encounter audits its players and stores the verdicts, so the
    /// log view and the audit page never have to re-run the rules.
    ///
    /// Also pins the STAMP. Without it every freshly saved log would look
    /// stale to the startup sweep and be re-audited on the next launch — the
    /// sweep would never converge and the write here would be pointless work.
    /// Behemoth III with the boss-set Healing Cap Up at its top: +75% against
    /// a +50% ceiling, so both summon-bonus rules fire.
    fn illegal_player() -> PlayerData {
        let mut player = PlayerData {
            display_name: "炎顺帝".to_string(),
            ..Default::default()
        };
        player.summons = vec![EquippedSummon {
            summon_id: 0xe4b7_dcf9,
            main_trait_id: 0xb5ff_9fd3,
            main_trait_level: 15,
            bonus_id: 0x2ea9_ca80,
            bonus_level: 9,
        }];
        player
    }

    #[test]
    fn saving_an_encounter_stores_its_findings_and_stamps_the_rules_version() {
        let mut parser = super::tests::parser_with_memory_db();

        // Inside the audited window. The default is epoch 0, which the cutoff
        // would skip — leaving this test green for the wrong reason.
        parser.derived_state.start_time = crate::legality::AUDIT_CUTOFF_MS;
        parser.encounter.player_data[2] = Some(illegal_player());

        let log_id = parser
            .save_encounter_to_db()
            .expect("save succeeds")
            .expect("a log row was written");

        let conn = parser.db.as_ref().expect("the fixture holds a connection");
        let stored = crate::db::legality::findings_for_log(conn, log_id).expect("read findings");
        assert_eq!(stored.len(), 2, "both summon-bonus rules should be stored");
        assert!(stored.iter().all(|row| row.player_index == 2));
        assert!(stored.iter().all(|row| row.display_name == "炎顺帝"));

        let stamp: Option<u32> = conn
            .query_row(
                "SELECT legality_rules_version FROM logs WHERE id = ?",
                [log_id],
                |row| row.get(0),
            )
            .expect("read the stamp");
        assert_eq!(stamp, Some(crate::legality::RULES_VERSION));
    }

    /// The cutoff holds on the SAVE path too, not only in the startup sweep.
    /// The sweep alone would leave this hole open: a log saved with a
    /// pre-cutoff start time is stamped current on the way in, so no sweep
    /// would ever revisit it and withdraw what the rules said about it.
    ///
    /// It is still saved and still stamped — only the audit is skipped.
    #[test]
    fn an_encounter_older_than_the_cutoff_is_saved_without_being_audited() {
        let mut parser = super::tests::parser_with_memory_db();
        parser.derived_state.start_time = crate::legality::AUDIT_CUTOFF_MS - 1;
        parser.encounter.player_data[2] = Some(illegal_player());

        let log_id = parser
            .save_encounter_to_db()
            .expect("save succeeds")
            .expect("a log row was written");

        let conn = parser.db.as_ref().expect("the fixture holds a connection");
        assert!(
            crate::db::legality::findings_for_log(conn, log_id)
                .expect("read findings")
                .is_empty(),
            "a pre-cutoff encounter must not be judged by tables baked from a later patch"
        );

        let stamp: Option<u32> = conn
            .query_row(
                "SELECT legality_rules_version FROM logs WHERE id = ?",
                [log_id],
                |row| row.get(0),
            )
            .expect("read the stamp");
        assert_eq!(stamp, Some(crate::legality::RULES_VERSION));
    }

    /// A legal party stores nothing but is still stamped, so the sweep leaves
    /// it alone. An unstamped clean log would be re-audited forever.
    #[test]
    fn a_clean_encounter_stores_no_findings_but_is_still_stamped() {
        let mut parser = super::tests::parser_with_memory_db();
        parser.encounter.player_data[0] = Some(PlayerData::default());

        let log_id = parser
            .save_encounter_to_db()
            .expect("save succeeds")
            .expect("a log row was written");

        let conn = parser.db.as_ref().expect("the fixture holds a connection");
        assert!(crate::db::legality::findings_for_log(conn, log_id)
            .expect("read findings")
            .is_empty());

        let stamp: Option<u32> = conn
            .query_row(
                "SELECT legality_rules_version FROM logs WHERE id = ?",
                [log_id],
                |row| row.get(0),
            )
            .expect("read the stamp");
        assert_eq!(stamp, Some(crate::legality::RULES_VERSION));
    }
}

/// Converts a v0 parser into a v1 parser, but does not reparse the encounter.
impl From<v0::Parser> for Parser {
    fn from(parser: v0::Parser) -> Self {
        let encounter = Encounter {
            event_log: parser.damage_event_log,
            ..Default::default()
        };

        Self {
            encounter,
            status: ParserStatus::Stopped,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use protocol::{ActionType, Actor, SUMMON_ATTACK_ACTION_ID};

    use super::*;

    /// The REAL migration list, not a hand-copied one. It used to be a copy,
    /// which meant a schema the save path depends on could be added without
    /// these tests noticing — and the save path now also writes findings, so
    /// a copy would have been missing a whole table.
    pub(super) fn parser_with_memory_db() -> Parser {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations().to_latest(&mut conn).unwrap();
        Parser {
            db: Some(conn),
            ..Default::default()
        }
    }

    /// Zeta's character hash — any real player hash works; an `Unknown` parent
    /// is dropped by `should_ignore_damage_event` on the live path.
    const PLAYER_HASH: u32 = 0x28AC1108;
    /// So0300 "(Primal Burst) Catastrophe" — taken from the shared list rather
    /// than restated, so a hash correction after a game patch reaches the tests.
    const PRIMAL_BURST_BODY: u32 = protocol::PRIMAL_BURST_BODY_HASHES[0];

    fn status_apply(status_id: u32) -> protocol::StatusApplyEvent {
        protocol::StatusApplyEvent {
            actor_index: 0,
            caster_index: Some(0),
            status_id,
            ability_id: None,
            status_class: None,
            caster_action_id: None,
            stacks: 1,
        }
    }

    #[test]
    fn a_status_applied_outside_a_fight_does_not_open_an_encounter() {
        // Statuses fire constantly in town — party buffs on load, food, regen.
        // Opening an encounter on one would fill the log with empty quests.
        let mut parser = Parser::default();

        parser.on_status_apply(status_apply(10));

        assert_eq!(parser.status, ParserStatus::Stopped);
        assert!(parser.encounter.raw_event_log.is_empty());
    }

    #[test]
    fn a_status_applied_during_a_fight_is_recorded() {
        let mut parser = Parser::default();
        parser.on_damage_event(damage_from(PLAYER_HASH, 100, 500));

        parser.on_status_apply(status_apply(10));

        assert!(parser
            .encounter
            .raw_event_log
            .iter()
            .any(|(_, message)| matches!(message, Message::StatusApply(_))));
    }

    #[test]
    fn a_status_removed_outside_a_fight_is_dropped() {
        // The mirror of the apply rule: a buff expiring in town belongs to no
        // encounter, and recording it would attach it to the NEXT one.
        let mut parser = Parser::default();

        parser.on_status_remove(protocol::StatusRemoveEvent {
            actor_index: 0,
            status_id: 10,
            ability_id: None,
        });

        assert!(parser.encounter.raw_event_log.is_empty());
    }

    /// A hit on enemy 9 credited to player slot 0. `body` is the acting actor's
    /// class (the player's own hash for a normal hit, a Primal Burst body for a
    /// burst); `action` is the skill id.
    fn damage_from(body: u32, action: u32, damage: i32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: if body == PLAYER_HASH { 0 } else { 1 },
                actor_type: body,
                parent_index: 0,
                parent_actor_type: PLAYER_HASH,
            },
            target: Actor {
                index: 9,
                actor_type: 0x1234,
                parent_index: 9,
                parent_actor_type: 0x1234,
            },
            damage,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: Some(50.0),
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
        }
    }

    /// An enemy hit ON party slot 0, shaped the way the hook publishes it now
    /// that player targets are slot-keyed: pointer-like enemy source, target
    /// keyed by the party slot with the character hash alongside.
    fn damage_taken_by_slot0(action: u32, damage: i32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0xF1EB_1234,
                actor_type: 0xDEAD_BEEF,
                parent_index: 0xF1EB_1234,
                parent_actor_type: 0xDEAD_BEEF,
            },
            target: Actor {
                index: 77,
                actor_type: PLAYER_HASH,
                parent_index: protocol::player_slot_key(0),
                parent_actor_type: PLAYER_HASH,
            },
            damage,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: Some(9_500),
            target_max_hp: Some(10_000),
            class_flags: None,
        }
    }

    /// A hit DEALT by party slot 0, keyed the way the hook keys player sources.
    /// `damage_from`'s parent index is a bare 0, which is a different party row
    /// from the slot-keyed one an incoming hit lands on.
    fn dealt_by_slot0(action: u32, damage: i32) -> DamageEvent {
        let mut event = damage_from(PLAYER_HASH, action, damage);
        event.source.parent_index = protocol::player_slot_key(0);
        event
    }

    /// Seeds party slot 0's identity — what the hook publishes alongside a DEALT
    /// hit, and the only thing that lets the overlay put a name on a row.
    fn identify_slot0(parser: &mut Parser) {
        parser.encounter.player_data[0] = Some(PlayerData {
            actor_index: protocol::player_slot_key(0),
            character_type: CharacterType::from_hash(PLAYER_HASH),
            ..Default::default()
        });
    }

    #[test]
    fn an_enemy_hit_on_a_player_is_recorded_and_derived_as_damage_taken() {
        let mut parser = Parser::default();
        identify_slot0(&mut parser);

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));

        assert_eq!(
            parser.encounter.raw_event_log.len(),
            1,
            "the hit belongs in the raw log"
        );
        let victim = parser
            .derived_state
            .party
            .get(&protocol::player_slot_key(0))
            .expect("the victim gets a party row");
        assert_eq!(victim.total_damage_taken, 750);
        assert_eq!(victim.hits_taken, 1);
        assert_eq!(victim.total_damage, 0, "taken damage is not dealt damage");
        assert_eq!(
            parser.derived_state.total_damage, 0,
            "taken damage must stay out of the encounter DPS totals"
        );
        assert_eq!(victim.damage_taken_breakdown.len(), 1);
        let row = &victim.damage_taken_breakdown[0];
        assert_eq!(row.enemy_type, EnemyType::from_hash(0xDEAD_BEEF));
        assert_eq!(row.action_id, ActionType::Normal(9001));
        assert_eq!(row.hits, 1);
        assert_eq!(row.total_damage, 750);
        assert_eq!(row.max_damage, 750);
    }

    /// Regression (live, 2026-08-08): an enemy hit is often the first thing that
    /// happens to a player, and this was the one row-creating path that did not
    /// need an identity to open a row. The overlay resolves a name by joining a
    /// row's slot key against `encounter.player_data`, which only a DEALT hit
    /// fills — so a victim who had not swung yet drew a bar with an icon and no
    /// name. Held pending instead, exactly as a guard's stun is.
    #[test]
    fn an_enemy_hit_on_an_unidentified_player_opens_no_row() {
        let mut parser = Parser::default();

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));

        assert!(
            parser.derived_state.party.is_empty(),
            "a row the overlay cannot name is never created"
        );
        assert_eq!(
            parser.encounter.raw_event_log.len(),
            1,
            "the hit is still the source of truth and belongs in the raw log"
        );
    }

    /// The other half of the gate: nothing is lost while the row is missing.
    /// Both hits land in full — totals, hit count and the per-attack breakdown —
    /// the moment the victim's own first hit opens their row.
    #[test]
    fn taken_damage_held_before_the_row_existed_folds_into_it() {
        let mut parser = Parser::default();

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));
        parser.on_damage_event(damage_taken_by_slot0(9001, 250));
        parser.on_damage_event(dealt_by_slot0(100, 1_000));

        let victim = parser
            .derived_state
            .party
            .get(&protocol::player_slot_key(0))
            .expect("the dealt hit opens the row the held hits were waiting for");
        assert_eq!(victim.total_damage_taken, 1_000);
        assert_eq!(victim.hits_taken, 2);
        assert_eq!(victim.total_damage, 1_000, "the dealt hit still counts");
        assert_eq!(victim.damage_taken_breakdown.len(), 1);
        let row = &victim.damage_taken_breakdown[0];
        assert_eq!(row.hits, 2);
        assert_eq!(row.total_damage, 1_000);
        assert_eq!(row.max_damage, 750, "the per-attack max survives the hold");
    }

    /// An identity arriving later must not double-count what the row already
    /// took: the hold is drained on the fold, not replayed on every later hit.
    #[test]
    fn taken_damage_lands_once_when_the_identity_arrives_after_the_row() {
        let mut parser = Parser::default();

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));
        parser.on_damage_event(dealt_by_slot0(100, 1_000));
        identify_slot0(&mut parser);
        parser.on_damage_event(damage_taken_by_slot0(9001, 250));

        let victim = parser
            .derived_state
            .party
            .get(&protocol::player_slot_key(0))
            .expect("the row exists");
        assert_eq!(victim.total_damage_taken, 1_000);
        assert_eq!(victim.hits_taken, 2);
    }

    #[test]
    fn damage_taken_opens_an_encounter_but_never_anchors_the_dps_window() {
        let mut parser = Parser::default();

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));

        assert_eq!(
            parser.status,
            ParserStatus::InProgress,
            "an ambush is a fight"
        );
        assert!(
            !parser.derived_state.window_anchored,
            "the DPS denominator starts at the first dealt hit, same as guards"
        );
    }

    #[test]
    fn reparse_rebuilds_damage_taken_and_keeps_it_out_of_dps() {
        let mut parser = Parser::default();
        // A stored log carries the party it was fought with, so the reparse has
        // the identities the live path had to wait for.
        identify_slot0(&mut parser);
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
        ));
        parser.encounter.raw_event_log.push((
            2_000,
            Message::DamageEvent(damage_taken_by_slot0(9001, 750)),
        ));

        parser.reparse();

        assert_eq!(parser.derived_state.total_damage, 1_000);
        let victim = parser
            .derived_state
            .party
            .get(&protocol::player_slot_key(0))
            .expect("the victim row is rebuilt from the raw log");
        assert_eq!(victim.total_damage_taken, 750);
        assert_eq!(victim.hits_taken, 1);
    }

    /// Per-player damage taken per second, bucketed for the analysis chart:
    /// only taken events count, keyed by the victim's slot key, and dealt
    /// damage never leaks in.
    #[test]
    fn taken_chart_buckets_incoming_damage_by_victim() {
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
            ),
            (
                1_500,
                Message::DamageEvent(damage_taken_by_slot0(9001, 300)),
            ),
            (
                3_000,
                Message::DamageEvent(damage_taken_by_slot0(9002, 200)),
            ),
        ];

        let chart =
            build_player_taken_chart(&events, &[protocol::player_slot_key(0)], 1_000, 1_000, 3);

        assert_eq!(
            chart.get(&protocol::player_slot_key(0)).unwrap(),
            &vec![300, 0, 200]
        );
        assert_eq!(chart.len(), 1, "no series for anyone who took nothing");
    }

    /// An event outside the chart's own span is dropped, not indexed.
    ///
    /// `chart_len` is sized from the LAST raw event's stamp rather than the
    /// maximum one, and `push_event` stamps wall clock — so a clock step during
    /// a fight can put an event past the end (or, going backwards, before the
    /// start, where `as usize` wraps to about 2^64). Either one used to index
    /// straight off the end and panic inside `fetch_encounter_state`, which the
    /// user sees as a log that will not open. Same guard the dealt walk's
    /// `bucket_for` and `aggregate_groups`' taken branch already carry.
    #[test]
    fn taken_chart_drops_events_outside_the_chart_span() {
        let events = vec![
            (
                1_500,
                Message::DamageEvent(damage_taken_by_slot0(9001, 300)),
            ),
            // Past the end (chart_len = 2 covers buckets 0..1).
            (
                9_000,
                Message::DamageEvent(damage_taken_by_slot0(9002, 400)),
            ),
            // Before the start: the subtraction goes negative.
            (0, Message::DamageEvent(damage_taken_by_slot0(9003, 500))),
        ];

        let chart =
            build_player_taken_chart(&events, &[protocol::player_slot_key(0)], 1_000, 1_000, 2);

        assert_eq!(
            chart.get(&protocol::player_slot_key(0)).unwrap(),
            &vec![300, 0]
        );
    }

    /// Two hits from the same enemy action fold into one breakdown row; a
    /// different attacker opens its own.
    #[test]
    fn damage_taken_breakdown_groups_by_attacker_and_action() {
        let mut parser = Parser::default();
        identify_slot0(&mut parser);

        parser.on_damage_event(damage_taken_by_slot0(9001, 750));
        parser.on_damage_event(damage_taken_by_slot0(9001, 250));
        let mut other_attacker = damage_taken_by_slot0(9001, 100);
        other_attacker.source.actor_type = 0xBEEF_CAFE;
        other_attacker.source.parent_actor_type = 0xBEEF_CAFE;
        parser.on_damage_event(other_attacker);

        let victim = parser
            .derived_state
            .party
            .get(&protocol::player_slot_key(0))
            .expect("victim row");
        assert_eq!(victim.total_damage_taken, 1_100);
        assert_eq!(victim.hits_taken, 3);
        assert_eq!(victim.damage_taken_breakdown.len(), 2);
        let same_attack = &victim.damage_taken_breakdown[0];
        assert_eq!(same_attack.hits, 2);
        assert_eq!(same_attack.total_damage, 1_000);
        assert_eq!(same_attack.max_damage, 750);
    }

    #[test]
    fn player_victims_never_become_target_segments() {
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
            ),
            (
                2_000,
                Message::DamageEvent(damage_taken_by_slot0(9001, 750)),
            ),
        ];

        let segments = segment_targets(&events, 1_000);

        assert_eq!(
            segments.len(),
            1,
            "only the enemy the player hit belongs in the target dropdown"
        );
    }

    #[test]
    fn player_hp_on_a_taken_event_is_not_enemy_hp_coverage() {
        let encounter = Encounter {
            raw_event_log: vec![(
                1_000,
                Message::DamageEvent(damage_taken_by_slot0(9001, 750)),
            )],
            ..Default::default()
        };

        assert!(!encounter.data_coverage().enemy_hp);
    }

    #[test]
    fn enemy_to_enemy_damage_is_still_ignored() {
        // The same enemy-sourced hit aimed at another enemy (raw index, no
        // slot key) must keep being dropped — only party victims are recorded.
        let mut event = damage_taken_by_slot0(9001, 750);
        event.target.index = 9;
        event.target.actor_type = 0x1234;
        event.target.parent_index = 9;
        event.target.parent_actor_type = 0x1234;

        assert!(Parser::should_ignore_damage_event(&event));
        assert!(!Parser::should_ignore_damage_event(&damage_taken_by_slot0(
            9001, 750
        )));
    }

    /// A parser holding one ordinary hit at t=1000 and one Primal Burst at
    /// t=2000, both credited to player slot 0.
    fn parser_with_a_burst() -> Parser {
        let mut parser = Parser::default();
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
        ));
        parser.encounter.raw_event_log.push((
            2_000,
            Message::DamageEvent(damage_from(
                PRIMAL_BURST_BODY,
                SUMMON_ATTACK_ACTION_ID,
                3_000,
            )),
        ));
        parser
    }

    #[test]
    fn event_page_returns_a_bounded_slice_in_order() {
        let mut parser = Parser::default();
        let base = 1_000;
        for offset in 0..10 {
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(a_damage_event()));
        }

        let page = event_page(
            &parser.encounter.raw_event_log,
            &parser.encounter.player_data,
            base,
            2,
            3,
        );

        assert_eq!(
            page.total, 10,
            "total counts every event, not just the page"
        );
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.events[0].0, 2, "timestamps are relative to start_time");
    }

    /// The card reconciles derived sources against the game's OWN total, so the
    /// events page has to carry that total per player. It is keyed by the same
    /// slot key a damage event reports as `source.parent_index`, because that is
    /// what the row already holds.
    #[test]
    fn cap_up_is_keyed_by_the_slot_key_a_damage_row_carries() {
        let mut parser = Parser::default();
        let mut event = identity_event("Gran", 0x26A4848A, 0, protocol::player_slot_key(0), false);
        event.cap_up_normal = Some(13.13);
        event.cap_up_skill = Some(15.18);
        event.cap_up_sba = Some(12.16);
        parser.on_player_identity_event(event);

        let map = cap_up_by_source(&parser.encounter.player_data);
        let entry = map
            .get(&protocol::player_slot_key(0))
            .expect("the player's slot key is the row's source index");
        assert_eq!(entry.normal, Some(13.13));
        assert_eq!(entry.skill, Some(15.18));
        assert_eq!(entry.sba, Some(12.16));
    }

    /// A log recorded before the capture must not report a cap-up of zero — the
    /// card would then show a base cap equal to the logged cap and an
    /// unaccounted row of 0%, which is a confident wrong answer.
    #[test]
    fn a_player_without_captured_cap_ups_is_absent_rather_than_zero() {
        let mut parser = Parser::default();
        parser.on_player_identity_event(identity_event(
            "Gran",
            0x26A4848A,
            0,
            protocol::player_slot_key(0),
            false,
        ));

        assert!(cap_up_by_source(&parser.encounter.player_data).is_empty());
    }

    #[test]
    fn event_page_clamps_an_offset_past_the_end() {
        let mut parser = Parser::default();
        parser
            .encounter
            .push_event(1_000, Message::DamageEvent(a_damage_event()));

        let page = event_page(
            &parser.encounter.raw_event_log,
            &parser.encounter.player_data,
            1_000,
            500,
            10,
        );

        assert_eq!(page.events.len(), 0, "past the end is empty, not a panic");
        assert_eq!(page.total, 1);
    }

    #[test]
    fn primal_burst_is_left_out_of_derived_totals_by_default() {
        let mut parser = parser_with_a_burst();

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0)
            .expect("the ordinary hit should still create a player row");
        assert_eq!(player.total_damage, 1_000, "burst damage must not count");
        assert_eq!(
            player.skill_breakdown.len(),
            1,
            "the burst should not open a breakdown row"
        );
        assert_eq!(parser.derived_state.total_damage, 1_000);
        assert_eq!(
            parser.derived_state.targets.get(&9).unwrap().total_damage,
            1_000,
            "enemy totals must drop the burst too"
        );
    }

    #[test]
    fn primal_burst_counts_when_the_filter_is_on() {
        let mut parser = parser_with_a_burst();
        parser.filters = MeterFilters {
            include_primal_burst: true,
        };

        parser.reparse();

        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(player.total_damage, 4_000);
        assert_eq!(player.skill_breakdown.len(), 2);
        assert_eq!(parser.derived_state.total_damage, 4_000);
    }

    #[test]
    fn echoes_keep_one_breakdown_row_per_causing_skill() {
        // The frontend folds every echo onto one DISPLAY row (`abilityRowKey`),
        // so the parser folding them too only destroyed the payload naming the
        // cause — which is what the collapse toggle attributes by.
        let mut parser = Parser::default();

        let mut first = damage_from(PLAYER_HASH, 0, 500);
        first.action_id = ActionType::SupplementaryDamage(100);
        let mut second = damage_from(PLAYER_HASH, 0, 300);
        second.action_id = ActionType::SupplementaryDamage(200);

        parser
            .encounter
            .raw_event_log
            .push((1_000, Message::DamageEvent(first)));
        parser
            .encounter
            .raw_event_log
            .push((2_000, Message::DamageEvent(second)));

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0)
            .expect("the dealing player's row");

        assert_eq!(
            player.skill_breakdown.len(),
            2,
            "one row per distinct echo payload"
        );

        let mut rows: Vec<(ActionType, u64)> = player
            .skill_breakdown
            .iter()
            .map(|skill| (skill.action_type, skill.total_damage))
            .collect();
        rows.sort();

        assert_eq!(
            rows,
            vec![
                (ActionType::SupplementaryDamage(100), 500),
                (ActionType::SupplementaryDamage(200), 300),
            ]
        );
    }

    #[test]
    fn excluded_damage_stays_in_the_raw_event_log() {
        // The raw log is the source of truth, so flipping the setting and
        // reparsing must bring the excluded damage straight back.
        let mut parser = parser_with_a_burst();
        parser.reparse();
        assert_eq!(parser.derived_state.total_damage, 1_000);

        parser.filters = MeterFilters {
            include_primal_burst: true,
        };
        parser.reparse();

        assert_eq!(parser.encounter.raw_event_log.len(), 2);
        assert_eq!(parser.derived_state.total_damage, 4_000);
    }

    /// The same hit as `damage_from`, aimed at `target_type` and reporting
    /// `max_hp` as the target's pool. `index` separates the two markers one cast
    /// spawns, which the game gives distinct spawn ids.
    fn damage_on_target(
        target_type: u32,
        index: u32,
        damage: i32,
        max_hp: Option<u64>,
    ) -> DamageEvent {
        let mut event = damage_from(PLAYER_HASH, 1602, damage);
        event.target = Actor {
            index,
            actor_type: target_type,
            parent_index: index,
            parent_actor_type: target_type,
        };
        event.target_current_hp = max_hp.map(|_| 0);
        event.target_max_hp = max_hp;
        event
    }

    /// One charged Flamek Thunder as the game reports it: the hit that lands on
    /// the enemy plus the two identical hits on the 1-HP markers the cast spawns
    /// (log 562, t+8784ms — all three at the same millisecond, same damage).
    fn parser_with_a_phantom_cast() -> Parser {
        const MARKER: u32 = crate::parser::v1::phantom_targets::EXCLUDED_TARGET_TYPES[1];
        let mut parser = Parser::default();
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(damage_on_target(0xa379ac65, 9, 4_174_929, Some(39_000_000))),
        ));
        for (offset, index) in [(0, 20), (0, 21)] {
            parser.encounter.raw_event_log.push((
                1_000 + offset,
                Message::DamageEvent(damage_on_target(MARKER, index, 4_174_929, Some(1))),
            ));
        }
        parser
    }

    #[test]
    fn marker_actors_spawned_by_a_cast_do_not_inflate_damage() {
        // One cast must be counted once, not three times.
        let mut parser = parser_with_a_phantom_cast();

        parser.reparse();

        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(
            player.total_damage, 4_174_929,
            "the cast's two markers must not be counted"
        );
        assert_eq!(parser.derived_state.total_damage, 4_174_929);
        assert_eq!(
            parser.derived_state.targets.len(),
            1,
            "markers must not open enemy rows"
        );
        let skill = &player.skill_breakdown[0];
        assert_eq!(skill.hits, 1, "one cast is one hit");
        assert_eq!(
            skill.targets.len(),
            1,
            "the per-enemy tooltip must not list a marker"
        );
    }

    #[test]
    fn a_marker_is_dropped_from_logs_recorded_before_the_rule_existed() {
        // The raw log is untouched, so the fix is retroactive: an old log still
        // holds the marker hits and loses them on the next reparse.
        let mut parser = parser_with_a_phantom_cast();

        parser.reparse();

        assert_eq!(
            parser.encounter.raw_event_log.len(),
            3,
            "the raw log stays the source of truth"
        );
        assert_eq!(parser.derived_state.total_damage, 4_174_929);
    }

    #[test]
    fn an_unlisted_marker_is_caught_by_its_hp_pool_alone() {
        // 0x60b55c0f is not on the hand-written list; its 1-HP pool is the only
        // thing identifying it, and most of its hits carry no HP read at all.
        let mut parser = Parser::default();
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(damage_on_target(0xa379ac65, 9, 1_000, Some(39_000_000))),
        ));
        parser.encounter.raw_event_log.push((
            1_100,
            Message::DamageEvent(damage_on_target(0x60b55c0f, 20, 546_000, None)),
        ));
        parser.encounter.raw_event_log.push((
            1_200,
            Message::DamageEvent(damage_on_target(0x60b55c0f, 20, 546_000, Some(1))),
        ));

        parser.reparse();

        assert_eq!(
            parser.derived_state.total_damage, 1_000,
            "both marker hits go, including the one with no HP read"
        );
    }

    #[test]
    fn excluded_primal_burst_carries_its_stun_out_with_it() {
        // The row is gone entirely, so its stun must go too — otherwise the
        // meter shows stun that no visible row accounts for. Asserted as a
        // comparison rather than an absolute: the exact stun a hit contributes
        // depends on the accumulator scaling, but including the burst must
        // strictly increase the total.
        let mut excluded = parser_with_a_burst();
        excluded.reparse();

        let mut included = parser_with_a_burst();
        included.filters = MeterFilters {
            include_primal_burst: true,
        };
        included.reparse();

        let excluded_stun = excluded
            .derived_state
            .party
            .get(&0)
            .unwrap()
            .total_stun_value;
        let included_stun = included
            .derived_state
            .party
            .get(&0)
            .unwrap()
            .total_stun_value;
        assert!(
            included_stun > excluded_stun,
            "burst stun should be counted only when the burst is: {included_stun} vs {excluded_stun}"
        );
        assert!(
            excluded.derived_state.stun_delta_sum < included.derived_state.stun_delta_sum,
            "the encounter-wide stun total must drop the burst as well"
        );
    }

    /// [`damage_from`] with no per-hit stun delta — the online shape, where the
    /// accumulator reads 0 and stun arrives as `OnPlayerStun` messages instead.
    fn stunless_damage_from(body: u32, action: u32, damage: i32) -> DamageEvent {
        DamageEvent {
            stun_value: None,
            ..damage_from(body, action, damage)
        }
    }

    /// An online-shaped log: an ordinary hit and a Primal Burst, each followed
    /// by the network stun message it produced.
    fn parser_with_online_burst_stun() -> Parser {
        let mut parser = Parser::default();
        let log = &mut parser.encounter.raw_event_log;
        log.push((
            1_000,
            Message::DamageEvent(stunless_damage_from(PLAYER_HASH, 100, 1_000)),
        ));
        log.push((
            1_100,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0,
                stun_amount: 30.0,
            }),
        ));
        log.push((
            2_000,
            Message::DamageEvent(stunless_damage_from(
                PRIMAL_BURST_BODY,
                SUMMON_ATTACK_ACTION_ID,
                3_000,
            )),
        ));
        log.push((
            2_100,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0,
                stun_amount: 70.0,
            }),
        ));
        parser
    }

    #[test]
    fn excluded_burst_drops_the_stun_message_trailing_it() {
        // Online, stun arrives as an action-id-free network message attributed
        // to the player's last stun-capable skill. Excluding the burst's damage
        // without excluding its message would leave the stun in the total AND
        // credit it to whatever skill preceded the burst.
        let mut parser = parser_with_online_burst_stun();
        parser.reparse();

        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(
            player.total_stun_value, 30.0,
            "only the ordinary hit's stun message should count"
        );

        let normal = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(100))
            .expect("the ordinary hit should have a row");
        assert_eq!(
            normal.total_stun_value, 30.0,
            "the burst's stun must not be credited to the preceding skill"
        );
    }

    #[test]
    fn included_burst_keeps_the_stun_message_trailing_it() {
        let mut parser = parser_with_online_burst_stun();
        parser.filters = MeterFilters {
            include_primal_burst: true,
        };
        parser.reparse();

        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(
            player.total_stun_value, 100.0,
            "with the burst counted, both messages count"
        );
    }

    #[test]
    fn reparsing_a_live_fight_leaves_it_in_progress() {
        // Toggling a filter mid-fight reparses. `reparse` rebuilds derived state
        // from Default, whose status is Stopped, so without re-applying the
        // parser's own status the overlay would switch to its finished-fight
        // rendering (frozen clock, latched party) for the rest of the fight —
        // `ensure_encounter_started` never runs again inside one encounter.
        let mut parser = Parser::default();
        parser.on_damage_event(damage_from(PLAYER_HASH, 100, 1_000));
        assert_eq!(
            parser.derived_state.status,
            ParserStatus::InProgress,
            "the first hit should open the encounter"
        );

        parser.reparse();

        assert_eq!(
            parser.derived_state.status,
            ParserStatus::InProgress,
            "a reparse must not report the fight as finished"
        );
    }

    // Overcap counters need no test of their own: the exclusion skips the whole
    // event before `update_from_damage_event` runs, so `cappable_hits`,
    // `capped_hits` and the overcap sums cannot diverge from `total_damage`
    // without the tests above failing first.

    #[test]
    fn dps_chart_buckets_damage_by_second_and_drops_filtered_hits() {
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
            ),
            (
                2_500,
                Message::DamageEvent(damage_from(
                    PRIMAL_BURST_BODY,
                    SUMMON_ATTACK_ACTION_ID,
                    3_000,
                )),
            ),
            (
                3_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 500)),
            ),
        ];

        let chart = build_player_dps_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        // Buckets are elapsed seconds from the start: hit 1 at 0s, the burst at
        // 1.5s (dropped), hit 3 at 2s.
        assert_eq!(chart.get(&0).unwrap(), &vec![1_000, 0, 500]);
    }

    #[test]
    fn dps_chart_includes_a_burst_when_the_filter_is_on() {
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
            ),
            (
                2_500,
                Message::DamageEvent(damage_from(
                    PRIMAL_BURST_BODY,
                    SUMMON_ATTACK_ACTION_ID,
                    3_000,
                )),
            ),
        ];

        let chart = build_player_dps_chart(
            &events,
            &[0],
            1_000,
            1_000,
            2,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters {
                    include_primal_burst: true,
                },
            },
        );

        assert_eq!(chart.get(&0).unwrap(), &vec![1_000, 3_000]);
    }

    #[test]
    fn dps_chart_keeps_only_the_selected_abilities() {
        // The analysis view pins an ability with no friendly: the chart must
        // narrow the same way the table does, or the two disagree on screen.
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 500)),
            ),
            (
                2_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 200, 700)),
            ),
        ];

        let chart = build_player_dps_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[ActionType::Normal(100)],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(
            chart.get(&0).unwrap(),
            &vec![500, 0, 0],
            "only the pinned ability counts"
        );
    }

    #[test]
    fn dps_chart_with_no_selected_abilities_counts_everything() {
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 500)),
            ),
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 200, 700)),
            ),
        ];

        let chart = build_player_dps_chart(
            &events,
            &[0],
            1_000,
            1_000,
            2,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(
            chart.get(&0).unwrap(),
            &vec![1_200, 0],
            "an empty list means All"
        );
    }

    /// `damage_from`, but landing on a chosen enemy — the drill-down target
    /// chart is the only thing that cares which one was hit.
    fn damage_onto(target_index: u32, action: u32, damage: i32) -> DamageEvent {
        let mut event = damage_from(PLAYER_HASH, action, damage);
        event.target.index = target_index;
        event.target.parent_index = target_index;
        event
    }

    #[test]
    fn a_spawn_records_the_actor_index_the_status_events_use() {
        // A damage event names its target twice: `index` is the target's
        // instance pointer folded to 32 bits, which is what tells two
        // simultaneous same-kind actors apart, and `parent_index` is the game's
        // own actor index. A status apply can only report the second — the
        // status hook sees the actor, not the damage instance — so the segment
        // has to keep it or an enemy's debuffs can never be matched to it.
        //
        // The real values from log 1614, where all 11 enemy-held intervals
        // resolved to no spawn because only `index` was recorded.
        let mut event = damage_onto(9, 100, 1_000);
        event.target.index = 2_785_501_876;
        event.target.parent_index = 977_212_104;

        let segments = segment_targets(&[(1_000, Message::DamageEvent(event))], 1_000);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].id, 2_785_501_876, "the per-spawn discriminator");
        assert_eq!(
            segments[0].actor_index, 977_212_104,
            "the bridge to the status events"
        );
    }

    /// The spec's shared-segment guarantee: the card path (SkillState.targets)
    /// and the groups path (aggregate_groups grouped by Target) must assign
    /// identical segments, because both must come from
    /// `segment_targets_indexed` over the same raw log — never re-derived.
    #[test]
    fn skill_target_entries_carry_the_groups_path_spawn_segments() {
        let mut parser = Parser::default();
        // Two spawns of the SAME enemy type (damage_onto keeps actor_type
        // 0x1234 for any target index): segments 0 and 1, instances #1 and #2.
        //
        // Non-damage events are interleaved (before both, and between them) so
        // the raw-log index diverges from the damage-event ordinal: the first
        // damage event sits at raw index 1 (ordinal 0) and the second at raw
        // index 3 (ordinal 1). This pins `segment_targets_indexed`'s
        // `event_index` to the raw log's position, not a filtered count — a
        // refactor that enumerated only damage events would still line up
        // ordinals 0/1 with segments 0/1 and pass regardless.
        parser.encounter.raw_event_log.push((
            900,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0,
                stun_amount: 0.0,
            }),
        ));
        parser
            .encounter
            .raw_event_log
            .push((1_000, Message::DamageEvent(damage_onto(9, 100, 400))));
        parser.encounter.raw_event_log.push((
            1_500,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0,
                stun_amount: 0.0,
            }),
        ));
        parser
            .encounter
            .raw_event_log
            .push((2_000, Message::DamageEvent(damage_onto(10, 100, 600))));

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0)
            .expect("the dealing player's row");
        assert_eq!(player.skill_breakdown.len(), 1, "one action, one skill row");
        let mut card_path: Vec<(Option<usize>, u64)> = player.skill_breakdown[0]
            .targets
            .iter()
            .map(|target| (target.segment, target.total_damage))
            .collect();
        card_path.sort();

        let (segments, assignment) =
            segment_targets_indexed(&parser.encounter.raw_event_log, parser.start_time());
        let query = GroupQuery {
            metric: GroupMetric::Damage,
            hostility: GroupHostility::Friendly,
            group_by: Dimension::Target,
            source: None,
            target: None,
            ability: None,
            top_n: None,
            from_ms: None,
            up_to_ms: None,
            windows: None,
        };
        let aggregates = aggregate_groups(
            &parser.encounter.raw_event_log,
            &Default::default(),
            &segments,
            &assignment,
            &query,
            parser.start_time(),
            1_000,
            2,
            MeterFilters::default(),
        )
        .expect("friendly damage grouped by target is supported");
        let mut groups_path: Vec<(Option<usize>, u64)> = aggregates
            .iter()
            .map(|aggregate| match aggregate.key {
                GroupKey::EnemySpawn { segment, .. } => {
                    (Some(segment), aggregate.measure.amount as u64)
                }
                ref other => panic!("expected spawn keys, got {other:?}"),
            })
            .collect();
        groups_path.sort();

        assert_eq!(
            card_path, groups_path,
            "the card path and the groups path must name the same spawns"
        );
        assert_eq!(card_path, vec![(Some(0), 400), (Some(1), 600)]);
    }

    #[test]
    fn dps_chart_rows_exist_only_for_the_given_players() {
        let events = vec![(
            1_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1_000)),
        )];

        let chart = build_player_dps_chart(
            &events,
            &[7],
            1_000,
            1_000,
            1,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        // Player 0 dealt the damage but has no row requested, so it is dropped
        // rather than invented — same as the pre-extraction loop.
        assert_eq!(chart.len(), 1);
        assert_eq!(chart.get(&7).unwrap(), &vec![0]);
    }

    /// One `OnPlayerStun` message at `at` ms crediting slot 0.
    fn stun_message(at: i64, amount: f32) -> (i64, Message) {
        (
            at,
            Message::OnPlayerStun(protocol::OnPlayerStunEvent {
                actor_index: 0,
                stun_amount: amount,
            }),
        )
    }

    #[test]
    fn stun_chart_buckets_the_delta_path_when_it_is_the_one_that_saw_the_accrual() {
        // `damage_from` carries stun_value 50.0, so two hits give a delta sum of
        // 100 against a message sum of 0 — the solo case.
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
            (
                3_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
        ];

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(chart.get(&0).unwrap(), &vec![50.0, 0.0, 50.0]);
    }

    #[test]
    fn stun_chart_buckets_the_message_path_when_it_is_the_larger_one() {
        // Online: the delta path reads 0 and the messages carry the stun. One
        // damage event still has to exist, or nothing establishes the player.
        let mut hit = damage_from(PLAYER_HASH, 100, 1);
        hit.stun_value = Some(0.0);
        let events = vec![
            (1_000, Message::DamageEvent(hit)),
            stun_message(1_000, 30.0),
            stun_message(3_000, 20.0),
        ];

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(chart.get(&0).unwrap(), &vec![30.0, 0.0, 20.0]);
    }

    #[test]
    fn stun_chart_never_sums_the_two_paths_together() {
        // Solo loopback fires BOTH paths for the same accrual. total_stun_value
        // is max(delta, messages), so the chart must pick a path — summing would
        // draw double the stun the table beneath it reports.
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
            stun_message(1_000, 50.0),
        ];

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            2,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        let series = chart.get(&0).unwrap();
        assert_eq!(series.iter().sum::<f64>(), 50.0);
    }

    #[test]
    fn stun_chart_totals_match_the_derived_player_total() {
        // The invariant that matters: a chart's area cannot disagree with the
        // row total it sits under.
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
            (
                2_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
            stun_message(2_500, 30.0),
        ];

        let mut state = DerivedEncounterState::default();
        for (timestamp, event) in &events {
            match event {
                Message::DamageEvent(event) => {
                    let instance = AdjustedDamageInstance::from_damage_event(event, None);
                    state.process_damage_event(*timestamp, &instance);
                }
                Message::OnPlayerStun(event) => state.process_stun_message(
                    *timestamp,
                    event.actor_index,
                    event.stun_amount as f64,
                ),
                _ => {}
            }
        }

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        let charted: f64 = chart.get(&0).unwrap().iter().sum();
        assert_eq!(charted, state.party.get(&0).unwrap().total_stun_value);
    }

    #[test]
    fn stun_chart_drops_a_message_trailing_an_excluded_hit() {
        // Same suppression rule as the meter: an excluded hit's trailing stun
        // message must not be credited to the skill before it.
        let mut burst = damage_from(PRIMAL_BURST_BODY, SUMMON_ATTACK_ACTION_ID, 3_000);
        burst.source.parent_index = 0;
        burst.stun_value = Some(0.0);
        let mut hit = damage_from(PLAYER_HASH, 100, 1);
        hit.stun_value = Some(0.0);

        let events = vec![
            (1_000, Message::DamageEvent(hit)),
            (2_000, Message::DamageEvent(burst)),
            stun_message(2_100, 40.0),
        ];

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(chart.get(&0).unwrap().iter().sum::<f64>(), 0.0);
    }

    #[test]
    fn stun_chart_counts_a_stun_effect_proc_on_the_delta_path() {
        // Eugen's sticky grenade: real stun with no damage event of its own.
        let events = vec![
            (
                1_000,
                Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
            ),
            (
                2_000,
                Message::OnStunEffect(protocol::OnPlayerStunEvent {
                    actor_index: 0,
                    stun_amount: 25.0,
                }),
            ),
        ];

        let chart = build_player_stun_chart(
            &events,
            &[0],
            1_000,
            1_000,
            2,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(chart.get(&0).unwrap(), &vec![50.0, 25.0]);
    }

    #[test]
    fn stun_chart_rows_exist_only_for_the_given_players() {
        let events = vec![(
            1_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 1)),
        )];

        let chart = build_player_stun_chart(
            &events,
            &[7],
            1_000,
            1_000,
            1,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );

        assert_eq!(chart.len(), 1);
        assert_eq!(chart.get(&7).unwrap(), &vec![0.0]);
    }

    #[test]
    fn live_damage_path_records_but_does_not_count_a_filtered_burst() {
        let mut parser = Parser::default();

        parser.on_damage_event(damage_from(PLAYER_HASH, 100, 1_000));
        parser.on_damage_event(damage_from(
            PRIMAL_BURST_BODY,
            SUMMON_ATTACK_ACTION_ID,
            3_000,
        ));

        assert_eq!(
            parser.encounter.raw_event_log.len(),
            2,
            "the raw log keeps everything — it is the source of truth"
        );
        assert_eq!(parser.derived_state.total_damage, 1_000);
        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(player.total_damage, 1_000);
        assert_eq!(player.skill_breakdown.len(), 1);
    }

    #[test]
    fn live_damage_path_counts_a_burst_when_the_filter_is_on() {
        let mut parser = Parser {
            filters: MeterFilters {
                include_primal_burst: true,
            },
            ..Default::default()
        };

        parser.on_damage_event(damage_from(PLAYER_HASH, 100, 1_000));
        parser.on_damage_event(damage_from(
            PRIMAL_BURST_BODY,
            SUMMON_ATTACK_ACTION_ID,
            3_000,
        ));

        assert_eq!(parser.derived_state.total_damage, 4_000);
        assert_eq!(
            parser
                .derived_state
                .party
                .get(&0)
                .unwrap()
                .skill_breakdown
                .len(),
            2
        );
    }

    #[test]
    fn excluded_damage_does_not_advance_the_encounter_end_time() {
        // A fight whose last hit is a filtered burst would otherwise keep that
        // hit's timestamp as the DPS denominator's upper bound.
        let mut parser = parser_with_a_burst();

        parser.reparse();

        assert_eq!(parser.derived_state.end_time, 1_000);
    }

    /// A parser holding two hits 4s apart in wall-clock time, 1000 damage in
    /// total, credited to player slot 0. The wall-clock denominator is 4s, so
    /// any in-game time other than 4s makes the two DPS figures distinguishable.
    fn parser_with_a_four_second_fight() -> Parser {
        let mut parser = Parser::default();
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 400)),
        ));
        parser.encounter.raw_event_log.push((
            5_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 600)),
        ));
        parser
    }

    fn a_tick(secs: u32) -> QuestElapsedTimeEvent {
        QuestElapsedTimeEvent {
            elapsed_time_in_secs: secs,
        }
    }

    /// A fight that never reaches a result screen — a wipe, a retire — still
    /// gets an in-game time, because the ticker reported one while it ran.
    /// Sourcing it only from the completion event would leave every failed
    /// attempt blank, which is most of a progression session.
    #[test]
    fn a_tick_records_the_in_game_time_without_a_completion() {
        let mut parser = Parser::default();

        parser.on_quest_elapsed_time(a_tick(47));

        assert_eq!(parser.encounter.quest_timer, Some(47));
    }

    /// The result screen's frozen clear time is the authoritative number and
    /// lands after the last tick the ticker managed to send. Asserted on the
    /// saved row: the in-memory timer is cleared at the quest boundary (Repeat
    /// Quest chains never revisit the load boundary), so the save is where the
    /// superseding is observable.
    #[test]
    fn the_clear_time_supersedes_the_last_tick() {
        let mut parser = parser_with_memory_db();
        parser.on_damage_event(a_damage_event());
        parser.on_quest_elapsed_time(a_tick(230));

        parser.on_quest_complete_event(QuestCompleteEvent {
            quest_id: 0x1234,
            elapsed_time_in_secs: 232,
        });

        let conn = parser.db.as_ref().unwrap();
        let timer: Option<u32> = conn
            .query_row("SELECT quest_elapsed_time FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(timer, Some(232));
    }

    /// An unknown quest id is no reason to throw away a known clear time.
    #[test]
    fn the_clear_time_survives_an_unknown_quest_id() {
        let mut parser = parser_with_memory_db();
        parser.on_damage_event(a_damage_event());

        parser.on_quest_complete_event(QuestCompleteEvent {
            quest_id: 0,
            elapsed_time_in_secs: 180,
        });

        let conn = parser.db.as_ref().unwrap();
        let (quest_id, timer): (Option<u32>, Option<u32>) = conn
            .query_row("SELECT quest_id, quest_elapsed_time FROM logs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(timer, Some(180));
        assert_eq!(quest_id, None, "id stays unknown");
    }

    /// The quest timer only advances within a quest, so a lower reading means
    /// the manager was reset or torn down and must not overwrite the time this
    /// encounter was actually fought over.
    #[test]
    fn the_in_game_time_never_goes_backwards() {
        let mut parser = Parser::default();

        parser.on_quest_elapsed_time(a_tick(200));
        parser.on_quest_elapsed_time(a_tick(5));
        parser.on_quest_elapsed_time(a_tick(0));

        assert_eq!(parser.encounter.quest_timer, Some(200));
    }

    fn a_perfect_guard(actor_index: u32) -> Message {
        Message::OnPerfectGuardStun(OnPlayerStunEvent {
            actor_index,
            stun_amount: 25.0,
        })
    }

    /// A guard is a real encounter event and belongs in the log, but it is not
    /// damage — dividing a fight's damage by a window that opened before anyone
    /// attacked understates DPS. Lucilius is the worst case: Paradise Lost is
    /// ~30s of guarding and dodging before the first hit lands.
    #[test]
    fn the_dps_window_opens_at_the_first_hit_not_at_an_earlier_guard() {
        let mut state = DerivedEncounterState::default();
        // The encounter opened on a guard, 30s before anyone attacked.
        state.start(0);
        state.process_perfect_guard_stun(0, &no_identities(), 0xF000_0000, 25.0);

        for (at, damage) in [(30_000i64, 400), (230_000, 600)] {
            let mut event = a_damage_event();
            event.source.parent_index = 0xF000_0000;
            event.damage = damage;
            let instance = AdjustedDamageInstance::from_damage_event(&event, None);
            state.process_damage_event(at, &instance);
        }

        assert_eq!(state.start_time, 30_000, "window opens at the first hit");
        assert_eq!(state.duration(), 200_000);
        assert_eq!(state.dps, 5.0, "1000 damage over 200s, not over 230s");
    }

    /// The same defect at the other end: the quest runs on after the boss dies,
    /// and a trailing guard would stretch the window the damage is divided by.
    #[test]
    fn a_guard_after_the_last_hit_does_not_extend_the_dps_window() {
        let mut parser = parser_with_a_four_second_fight();
        parser
            .encounter
            .raw_event_log
            .push((30_000, a_perfect_guard(0)));

        parser.reparse();

        assert_eq!(parser.derived_state.end_time, 5_000);
        assert_eq!(parser.derived_state.duration(), 4_000);
    }

    /// The reparse path has to reach the same window as the live path, or a
    /// saved log would disagree with the meter that recorded it.
    #[test]
    fn reparse_opens_the_dps_window_at_the_first_hit_not_at_an_earlier_guard() {
        let mut parser = Parser::default();
        parser
            .encounter
            .raw_event_log
            .push((1_000, a_perfect_guard(0)));
        parser.encounter.raw_event_log.push((
            5_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 400)),
        ));
        parser.encounter.raw_event_log.push((
            9_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 600)),
        ));

        parser.reparse();

        assert_eq!(parser.derived_state.start_time, 5_000);
        assert_eq!(parser.derived_state.duration(), 4_000);
    }

    /// The scrubber picks the window explicitly, so the first-hit anchor must
    /// leave it alone — otherwise dragging the handle to a quiet stretch would
    /// silently snap back to the first hit inside it.
    #[test]
    fn an_explicit_scrub_window_keeps_its_own_start() {
        let mut parser = Parser::default();
        parser
            .encounter
            .raw_event_log
            .push((1_000, a_perfect_guard(0)));
        parser.encounter.raw_event_log.push((
            5_000,
            Message::DamageEvent(damage_from(PLAYER_HASH, 100, 400)),
        ));

        parser.reparse_with_options_window(&[], Some(0), Some(6_000));

        assert_eq!(parser.derived_state.start_time, 1_000, "window start wins");
    }

    fn a_damage_event() -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0,
                actor_type: 0x2AF6_78E8,
                parent_actor_type: 0x2AF6_78E8,
                parent_index: 0,
            },
            target: Actor {
                index: 1,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 1,
            },
            damage: 500,
            flags: 0,
            action_id: ActionType::Normal(1),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
        }
    }

    /// Player-data array with no identities: guard events resolve no character
    /// type and are held pending until the player's first damage event.
    fn no_identities() -> [Option<PlayerData>; 4] {
        [None, None, None, None]
    }

    /// Stun totals must be max(delta, messages) at both player and encounter
    /// level: the two capture paths (accumulator delta solo, network messages
    /// online) observe the SAME accrual, so if both fire the totals must not
    /// double, and if only one fires it must win outright.
    #[test]
    fn stun_message_and_delta_paths_never_double_count() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // Stun message arriving BEFORE the player's first damage event is held
        // and folded in when the row is created.
        state.process_stun_message(0, 0xF000_0000, 30.0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.stun_value = Some(30.0); // the delta path saw the same 30 stun
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        let player = state.party.get(&0xF000_0000).expect("player row");
        assert_eq!(player.total_stun_value, 30.0); // max(30, 30), not 60
        assert_eq!(state.total_stun_value, 30.0);

        // Online shape: delta dead (0), messages carry everything.
        state.process_stun_message(0, 0xF000_0000, 20.0);
        let player = state.party.get(&0xF000_0000).expect("player row");
        assert_eq!(player.stun_message_sum, 50.0);
        assert_eq!(player.total_stun_value, 50.0); // max(30 delta, 50 messages)
        assert_eq!(state.total_stun_value, 50.0);
    }

    /// Perfect Guard stun is captured as a SOURCE-side accumulator delta on the
    /// enemy's own attack (no player damage event exists for a guard), so it
    /// belongs to the DELTA path: it must survive the max(delta, messages)
    /// dedupe even when hit stun arrives duplicated via messages, and a guard
    /// landed before the player's first damage event must fold in when their
    /// row is created.
    #[test]
    fn perfect_guard_stun_adds_to_delta_path_and_survives_row_creation() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // Guard happens before the player has dealt any damage: no row yet.
        state.process_perfect_guard_stun(0, &no_identities(), 0xF000_0000, 25.0);
        assert_eq!(state.total_stun_value, 25.0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.stun_value = Some(30.0);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        let player = state.party.get(&0xF000_0000).expect("player row");
        assert_eq!(player.stun_delta_sum, 55.0); // 25 guard (pending) + 30 hit
        assert_eq!(player.total_stun_value, 55.0);
        assert_eq!(state.total_stun_value, 55.0);

        // Solo shape: the hit stun ALSO arrives duplicated as a message (30),
        // but the guard stun exists only on the delta path — the max() dedupe
        // must not lose it.
        state.process_stun_message(0, 0xF000_0000, 30.0);
        let player = state.party.get(&0xF000_0000).expect("player row");
        assert_eq!(player.total_stun_value, 55.0); // max(55 delta, 30 messages)
        assert_eq!(state.total_stun_value, 55.0);

        // A guard after the row exists adds directly.
        state.process_perfect_guard_stun(0, &no_identities(), 0xF000_0000, 5.0);
        let player = state.party.get(&0xF000_0000).expect("player row");
        assert_eq!(player.stun_delta_sum, 60.0);
        assert_eq!(player.total_stun_value, 60.0);
        assert_eq!(state.total_stun_value, 60.0);
    }

    /// A non-guard stun-effect proc (Eugen's sticky grenade) routes to the
    /// player's own `StunEffect` row — never Perfect Guard — and one landing
    /// before the player's first damage event folds in on row creation.
    #[test]
    fn stun_effect_routes_to_its_own_row_and_survives_pending() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // Proc before any damage: held pending, still counted in the total.
        state.process_stun_effect(&no_identities(), 0xF000_0000, 25.0);
        assert_eq!(state.total_stun_value, 25.0);
        assert!(state.party.get(&0xF000_0000).is_none());

        // First damage event creates the row and folds the pending proc in.
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.stun_value = None;
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        // A proc after the row exists adds directly.
        state.process_stun_effect(&no_identities(), 0xF000_0000, 25.0);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let effect = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::StunEffect(0))
            .expect("stun effect row");
        assert_eq!(effect.hits, 2);
        assert_eq!(effect.total_stun_value, 50.0);
        assert_eq!(effect.stun_eligible_hits, 2);
        // The procs are NEVER a Perfect Guard.
        assert!(player
            .skill_breakdown
            .iter()
            .all(|s| s.action_type != ActionType::PerfectGuard));
        assert_eq!(state.total_stun_value, 50.0);
    }

    /// Every Perfect Guard also materializes as a zero-damage breakdown row on
    /// the guarding player (name via `ActionType::PerfectGuard`), counting
    /// guards as hits and carrying only stun — including guards held pending
    /// before the player's first damage event.
    #[test]
    fn perfect_guard_stun_creates_a_breakdown_row_counting_guards() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // One guard before the player's row exists (held pending)...
        state.process_perfect_guard_stun(0, &no_identities(), 0xF000_0000, 25.0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        // ...and one after.
        state.process_perfect_guard_stun(0, &no_identities(), 0xF000_0000, 40.0);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuard)
            .expect("perfect guard breakdown row");
        assert_eq!(row.hits, 2);
        assert_eq!(row.total_stun_value, 65.0);
        assert_eq!(row.max_stun_value, 40.0);
        assert_eq!(row.total_damage, 0);
        assert_eq!(row.min_damage, None);
        assert_eq!(player.total_stun_value, 65.0);
    }

    /// Online, the per-hit delta path is structurally 0 (stun is
    /// host-authoritative), so per-skill stun comes from the network stun
    /// messages: each message is attributed to the source player's most recent
    /// stun-CAPABLE action. Supplementary echoes and DoT ticks interleave
    /// between real hits (an echo lands ~150ms after its trigger, right when
    /// the stun message arrives) and never proc stun themselves, so they must
    /// not steal the attribution.
    #[test]
    fn stun_messages_attribute_to_the_players_last_stun_capable_action() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.action_id = ActionType::Normal(1);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        state.process_stun_message(0, 0xF000_0000, 5.0);

        // An echo and a DoT tick land after the hit; the next stun message must
        // still attribute to the real skill.
        let mut echo = a_damage_event();
        echo.source.parent_index = 0xF000_0000;
        echo.action_id = ActionType::SupplementaryDamage(1);
        let echo_instance = AdjustedDamageInstance::from_damage_event(&echo, None);
        state.process_damage_event(1_100, &echo_instance);

        let mut dot = a_damage_event();
        dot.source.parent_index = 0xF000_0000;
        dot.action_id = ActionType::DamageOverTime(1);
        let dot_instance = AdjustedDamageInstance::from_damage_event(&dot, None);
        state.process_damage_event(1_200, &dot_instance);

        state.process_stun_message(0, 0xF000_0000, 3.0);

        // Switching skills moves the attribution.
        let mut second = a_damage_event();
        second.source.parent_index = 0xF000_0000;
        second.action_id = ActionType::Normal(2);
        let second_instance = AdjustedDamageInstance::from_damage_event(&second, None);
        state.process_damage_event(1_300, &second_instance);

        state.process_stun_message(0, 0xF000_0000, 4.0);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let first_row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("first skill row");
        assert_eq!(first_row.total_stun_value, 8.0); // 5 + 3
        assert_eq!(first_row.max_stun_value, 5.0);

        let second_row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(2))
            .expect("second skill row");
        assert_eq!(second_row.total_stun_value, 4.0);

        for skill in &player.skill_breakdown {
            if matches!(
                skill.action_type,
                ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
            ) {
                assert_eq!(skill.total_stun_value, 0.0);
            }
        }

        assert_eq!(player.total_stun_value, 12.0);
        assert_eq!(state.total_stun_value, 12.0);
    }

    /// Solo, BOTH capture paths can fire for the same accrual (loopback): the
    /// per-hit delta lands on the row via the damage event AND the same amount
    /// arrives as a stun message attributed to the same row. Row totals must be
    /// max(delta, messages), mirroring the player/encounter dedupe.
    #[test]
    fn skill_row_stun_survives_solo_loopback_without_double_count() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.action_id = ActionType::Normal(1);
        event.stun_value = Some(6.0);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        // The same 6 stun arrives duplicated via the message path.
        state.process_stun_message(0, 0xF000_0000, 6.0);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("skill row");
        assert_eq!(row.total_stun_value, 6.0); // max(6, 6), not 12
        assert_eq!(player.total_stun_value, 6.0);
        assert_eq!(state.total_stun_value, 6.0);
    }

    /// A guarded Quickening (The World) is counted as its own hits-only
    /// breakdown row (`ActionType::PerfectGuardQuickening`): no stun, no
    /// damage, and no contribution to any stun/damage total — including guards
    /// held pending before the player's first damage event.
    #[test]
    fn perfect_guard_quickening_counts_hits_only() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // One guard before the player's row exists (held pending)...
        state.process_perfect_guard_quickening(&no_identities(), 0xF000_0000);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        // ...and one after.
        state.process_perfect_guard_quickening(&no_identities(), 0xF000_0000);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuardQuickening)
            .expect("perfect guard quickening breakdown row");
        assert_eq!(row.hits, 2);
        assert_eq!(row.total_stun_value, 0.0);
        assert_eq!(row.max_stun_value, 0.0);
        assert_eq!(row.total_damage, 0);
        assert_eq!(row.min_damage, None);
        assert_eq!(row.max_damage, None);
        assert_eq!(player.total_stun_value, 0.0);
        assert_eq!(state.total_stun_value, 0.0);
    }

    /// A guard from a player who never attacks must still show. Identity
    /// events land at quest load — before any guard is possible — so the
    /// guard handlers create the party row from the identity snapshot instead
    /// of holding the guard until the player's first damage event (which may
    /// never come for a dedicated guarder).
    #[test]
    fn quickening_guard_before_first_attack_shows_via_identity() {
        let mut parser = Parser::default();
        parser.on_player_identity_event(identity_event("Bob", 0x91418145, 0, 4_217_578_216, false));

        parser.on_perfect_guard_quickening(OnPlayerStunEvent {
            actor_index: 0xF000_0000,
            stun_amount: 0.0,
        });

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row created from the identity snapshot");
        assert_eq!(player.character_type, CharacterType::from_hash(0x91418145));
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuardQuickening)
            .expect("quickening row without any damage event");
        assert_eq!(row.hits, 1);
        assert_eq!(player.total_damage, 0);
    }

    /// Same for the generic Perfect Guard: the row (and its stun) must not
    /// depend on the guarding player having attacked.
    #[test]
    fn perfect_guard_before_first_attack_shows_via_identity() {
        let mut parser = Parser::default();
        parser.on_player_identity_event(identity_event("Bob", 0x91418145, 0, 4_217_578_216, false));

        parser.on_perfect_guard_stun(OnPlayerStunEvent {
            actor_index: 0xF000_0000,
            stun_amount: 250.4,
        });

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row created from the identity snapshot");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuard)
            .expect("perfect guard row without any damage event");
        assert_eq!(row.hits, 1);
        // The wire carries stun as f32, so compare at f32 precision.
        assert!((player.total_stun_value - 250.4).abs() < 1e-3);
    }

    /// A REMOTE player's guard applies its stun host-side, so it arrives as a
    /// NETWORK stun message trailing the guard — live capture 07-22: the three
    /// real remote guards were each followed at +100/+100/+101ms by a message
    /// carrying 188.4/188.4/125.6, while that slot's skill messages carried
    /// 12-71. Without a guard attribution that stun silently lands on whatever
    /// skill the player last hit with, and the guard row reads 0.
    #[test]
    fn a_guards_trailing_stun_message_credits_the_guard_row() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // A skill hit first, so the fallback attribution points somewhere else.
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.action_id = ActionType::Normal(1);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        // Remote guard: no observable delta here, then its message 100ms later.
        state.process_perfect_guard_stun(2_000, &no_identities(), 0xF000_0000, 0.0);
        state.process_stun_message(2_100, 0xF000_0000, 188.4);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let guard = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuard)
            .expect("guard row");
        assert_eq!(guard.total_stun_value, 188.4);

        let skill = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("skill row");
        assert_eq!(
            skill.total_stun_value, 0.0,
            "the guard's stun is not the skill's"
        );
    }

    /// The guard only claims the message that trails it. A message arriving well
    /// after the guard belongs to the player's ordinary attacks again, so the
    /// attribution falls back to their last stun-capable skill.
    #[test]
    fn a_stun_message_long_after_a_guard_attributes_to_the_last_skill() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.action_id = ActionType::Normal(1);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        state.process_perfect_guard_stun(2_000, &no_identities(), 0xF000_0000, 0.0);
        state.process_stun_message(2_400, 0xF000_0000, 9.0);

        let player = state.party.get(&0xF000_0000).expect("player row");
        let guard = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuard)
            .expect("guard row");
        assert_eq!(guard.total_stun_value, 0.0);

        let skill = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("skill row");
        assert_eq!(skill.total_stun_value, 9.0);
    }

    /// A guard that applied NO stun is noise when the LOCAL player made it: the
    /// hook measures the enemy's stun accumulator across the guarded call, which
    /// the local client applies in-call, so a real local guard always registers
    /// (every one of the 133 stun-carrying guards in the stored corpus is local).
    /// Live capture 07-22: local 0-stun guards arrive in bursts of 30-40 inside
    /// 150ms with no stun anywhere in the burst.
    #[test]
    fn zero_stun_perfect_guards_are_dropped_for_the_local_player() {
        let mut parser = Parser::default();
        parser.on_player_identity_event(identity_event("Bob", 0x91418145, 0, 4_217_578_216, false));

        parser.on_perfect_guard_stun(OnPlayerStunEvent {
            actor_index: 0xF000_0000,
            stun_amount: 0.0,
        });

        let guards = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .into_iter()
            .flat_map(|player| player.skill_breakdown.iter())
            .find(|skill| skill.action_type == ActionType::PerfectGuard);
        assert!(guards.is_none(), "a stunless local guard must not be shown");
    }

    /// ...but a REMOTE player's guard legitimately reports 0: their stun is
    /// host-authoritative and lands asynchronously, so the local process's
    /// in-call delta is structurally 0 (821 of 821 remote guards in the stored
    /// corpus carried no stun). Dropping those would erase remote guard tracking
    /// entirely, so they still count as hits.
    #[test]
    fn zero_stun_perfect_guards_are_kept_for_remote_players() {
        let mut parser = Parser::default();
        parser.on_player_identity_event(identity_event("Ally", 0x91418145, 1, 4_217_578_217, true));

        parser.on_perfect_guard_stun(OnPlayerStunEvent {
            actor_index: 0xF000_0001,
            stun_amount: 0.0,
        });

        let row = parser
            .derived_state
            .party
            .get(&0xF000_0001)
            .expect("party row")
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::PerfectGuard)
            .expect("remote guards stay countable even without measurable stun");
        assert_eq!(row.hits, 1);
    }

    /// Target HP tracking: each hit carries the target's post-hit current/max HP
    /// (read from the ExHp component). The derived target keeps the values of the
    /// LARGEST pool seen under its key (multi-part bosses report per-part pools
    /// keyed to the same parent), updates current whenever the same pool reports,
    /// and never clobbers known values with hp-less events (DoT, old logs).
    #[test]
    fn target_hp_tracks_largest_pool_and_ignores_missing() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        // First hit on the boss main body: 50m pool, 49m remaining.
        let mut event = a_damage_event();
        event.target_current_hp = Some(49_000_000);
        event.target_max_hp = Some(50_000_000);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(1_000, &instance);

        let target = state.targets.get(&1).expect("target row");
        assert_eq!(target.current_hp, Some(49_000_000));
        assert_eq!(target.max_hp, Some(50_000_000));

        // A part with a smaller pool under the same parent must not clobber.
        let mut event = a_damage_event();
        event.target_current_hp = Some(9_000_000);
        event.target_max_hp = Some(10_000_000);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(2_000, &instance);

        let target = state.targets.get(&1).expect("target row");
        assert_eq!(target.current_hp, Some(49_000_000));
        assert_eq!(target.max_hp, Some(50_000_000));

        // Same pool reporting again updates current HP.
        let mut event = a_damage_event();
        event.target_current_hp = Some(48_000_000);
        event.target_max_hp = Some(50_000_000);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(3_000, &instance);

        let target = state.targets.get(&1).expect("target row");
        assert_eq!(target.current_hp, Some(48_000_000));

        // An hp-less event (DoT / old log) leaves known values untouched.
        let event = a_damage_event();
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(4_000, &instance);

        let target = state.targets.get(&1).expect("target row");
        assert_eq!(target.current_hp, Some(48_000_000));
        assert_eq!(target.max_hp, Some(50_000_000));
    }

    /// Regression: `targets` is keyed on the game's actor index, which is REUSED across
    /// boss phases and summon waves. Latching on the largest pool ever seen left a killed
    /// phase-1 pool pinned at 0% forever — a smaller phase-2 pool could never satisfy
    /// `max >= known`, so the overlay read "HP 0.0%" while the player fought a live enemy.
    #[test]
    fn target_hp_lets_a_new_pool_replace_a_dead_one_under_a_reused_index() {
        let mut state = DerivedEncounterState::default();
        state.start(0);

        let hit = |current: u64, max: u64| {
            let mut event = a_damage_event();
            event.target_current_hp = Some(current);
            event.target_max_hp = Some(max);
            event
        };

        // Phase 1: a 50m pool, fought down to zero.
        for (ts, current) in [(1_000, 25_000_000), (2_000, 0)] {
            let event = hit(current, 50_000_000);
            let instance = AdjustedDamageInstance::from_damage_event(&event, None);
            state.process_damage_event(ts, &instance);
        }
        assert_eq!(state.targets[&1].current_hp, Some(0));

        // Phase 2 reuses the index with a SMALLER pool — it must take over.
        let event = hit(29_000_000, 30_000_000);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(3_000, &instance);

        let target = state.targets.get(&1).expect("target row");
        assert_eq!(
            target.max_hp,
            Some(30_000_000),
            "live pool takes over the corpse"
        );
        assert_eq!(target.current_hp, Some(29_000_000));

        // ...but a smaller multi-part pool reported while the tracked one is ALIVE is
        // still ignored, which is what the largest-pool rule exists for.
        let event = hit(1_000, 2_000);
        let instance = AdjustedDamageInstance::from_damage_event(&event, None);
        state.process_damage_event(4_000, &instance);
        assert_eq!(state.targets[&1].max_hp, Some(30_000_000));
    }

    /// The quest-details HP charts: one series per (parent_index, max) pool
    /// passing the target filter, largest pool first, post-hit HP% bucketed by
    /// time (last report in a bucket wins; unhit buckets are None). Duplicate
    /// enemy types get 1-based instance numbers so labels can disambiguate.
    #[test]
    fn hp_charts_series_per_pool_largest_first_and_respect_target_filter() {
        const BOSS_HASH: u32 = 0xB055_0001;
        const ADD_HASH: u32 = 0x0ADD_0001;

        let hit = |ts: i64, spawn_id: u32, type_hash: u32, current: u64, max: u64| {
            let mut event = a_damage_event();
            // The hook fills index with its per-spawn id and parent_index with
            // the game's (summon-collapsed) index; pools key on the former.
            event.target.index = spawn_id;
            event.target.parent_index = spawn_id;
            event.target.parent_actor_type = type_hash;
            event.target_current_hp = Some(current);
            event.target_max_hp = Some(max);
            (ts, Message::DamageEvent(event))
        };

        let events = vec![
            hit(0, 1, BOSS_HASH, 100_000, 100_000),
            hit(1_000, 1, BOSS_HASH, 90_000, 100_000), // bucket 0: last report wins
            hit(3_500, 2, ADD_HASH, 50, 100),          // smaller pool, bucket 1
            hit(4_000, 3, ADD_HASH, 75, 100),          // second add pool, bucket 1
            hit(7_000, 1, BOSS_HASH, 50_000, 100_000), // bucket 2
        ];

        let segments = segment_targets(&events, 0);
        let charts = build_target_hp_charts(
            &events,
            &segments,
            0,
            3_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );
        assert_eq!(charts.len(), 3);

        // Largest pool first; smaller pools never pollute its line.
        assert_eq!(charts[0].enemy_type, EnemyType::from_hash(BOSS_HASH));
        assert_eq!(charts[0].max_hp, 100_000);
        assert_eq!(charts[0].instance, 1);
        assert_eq!(charts[0].values, vec![Some(90.0), None, Some(50.0)]);

        // Same-type pools keep first-hit order and get instance numbers.
        assert_eq!(charts[1].enemy_type, EnemyType::from_hash(ADD_HASH));
        assert_eq!(charts[1].instance, 1);
        assert_eq!(charts[1].values, vec![None, Some(50.0), None]);
        assert_eq!(charts[2].instance, 2);
        assert_eq!(charts[2].values, vec![None, Some(75.0), None]);

        // Filtering by spawn span selects ONE add out of the two sharing a type.
        let span = TargetSpan {
            id: 3,
            start_ms: 0,
            end_ms: 10_000,
        };
        let charts = build_target_hp_charts(
            &events,
            &segments,
            0,
            3_000,
            3,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[span],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );
        assert_eq!(charts.len(), 1);
        assert_eq!(charts[0].values, vec![None, Some(75.0), None]);

        // Events without HP data can never produce a chart.
        let bare = vec![(0, Message::DamageEvent(a_damage_event()))];
        let bare_segments = segment_targets(&bare, 0);
        assert!(build_target_hp_charts(
            &bare,
            &bare_segments,
            0,
            3_000,
            1,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        )
        .is_empty());
    }

    /// Lucilius' summon waves: every wave's swords report the SAME collapsed
    /// game index (and a freed instance id can be reused), so a pool whose HP
    /// jumps back UP to near-full is a new spawn behind a reused key — it must
    /// open a new series, while an ordinary partial heal must not.
    #[test]
    fn hp_charts_split_a_new_series_when_a_pool_respawns_at_full() {
        const SWORD_HASH: u32 = 0x0511_0001;

        let hit = |ts: i64, spawn_id: u32, current: u64, max: u64| {
            let mut event = a_damage_event();
            event.target.index = spawn_id;
            event.target.parent_index = spawn_id;
            event.target.parent_actor_type = SWORD_HASH;
            event.target_current_hp = Some(current);
            event.target_max_hp = Some(max);
            (ts, Message::DamageEvent(event))
        };

        let events = vec![
            hit(0, 7, 100, 141),       // wave 1, bucket 0
            hit(1_000, 7, 10, 141),    // wave 1 nearly dead, still bucket 0
            hit(6_000, 7, 140, 141),   // near-full + was nearly dead = wave 2, bucket 2
            hit(7_000, 7, 60, 141),    // wave 2, bucket 2: last report wins
            hit(8_000, 9, 100, 200),   // separate pool...
            hit(8_500, 9, 120, 200),   // ...healed to 60% — no respawn evidence
            hit(9_000, 11, 90, 141),   // third pool, despawns mid-HP (64%)...
            hit(45_000, 11, 140, 141), // ...back near full after a 36s quiet gap = new wave
        ];

        let segments = segment_targets(&events, 0);
        let charts = build_target_hp_charts(
            &events,
            &segments,
            0,
            3_000,
            16,
            &ChartScope {
                player_data: &Default::default(),
                target_spans: &[],
                abilities: &[],
                filters: MeterFilters::default(),
            },
        );
        assert_eq!(charts.len(), 5);

        // Largest first: the (healed, unsplit) 200-max pool. Instance numbers
        // are CHRONOLOGICAL per type (this pool spawned third), matching the
        // dropdown's numbering, not the chart's display order.
        assert_eq!(charts[0].max_hp, 200);
        assert_eq!(charts[0].instance, 3);
        assert_eq!(charts[0].values[2], Some(60.0));

        // ...then the 141-max series in spawn order.
        let percent = |current: f64| Some((current / 141.0 * 100.0) as f32);
        assert_eq!(charts[1].instance, 1);
        assert_eq!(charts[1].values[0], percent(10.0)); // wave 1 froze where it ended
        assert_eq!(charts[1].values[2], None);
        assert_eq!(charts[2].instance, 2);
        assert_eq!(charts[2].values[2], percent(60.0)); // wave 2 owns bucket 2
        assert_eq!(charts[3].instance, 4);
        assert_eq!(charts[3].values[3], percent(90.0)); // despawned-at-64% pool
        assert_eq!(charts[4].instance, 5);
        assert_eq!(charts[4].values[15], percent(140.0)); // quiet-gap respawn
    }

    /// Old logs carry no HP data at all — targets must still segment (one
    /// segment per spawn id) so the filter dropdown has entries to offer.
    #[test]
    fn segment_targets_covers_hp_less_logs() {
        let events = vec![
            (1_000, Message::DamageEvent(a_damage_event())),
            (6_000, Message::DamageEvent(a_damage_event())),
        ];

        let segments = segment_targets(&events, 1_000);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].instance, 1);
        assert_eq!(segments[0].max_hp, None);
        assert_eq!((segments[0].start_ms, segments[0].end_ms), (0, 5_000));
    }

    /// Scrubbing the quest-details view reparses the meter "as of" a time: events
    /// after the cutoff (relative to the first event) are excluded, so totals,
    /// DPS duration, and per-target damage all reflect that moment of the fight.
    #[test]
    fn reparse_until_excludes_events_after_the_cutoff() {
        let mut parser = Parser::default();
        let base = 10_000; // arbitrary absolute start timestamp

        for (offset, damage) in [(0, 100), (4_000, 200), (8_000, 400)] {
            let mut event = a_damage_event();
            event.damage = damage;
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        parser.reparse_with_options_window(&[], None, Some(5_000));
        assert_eq!(parser.derived_state.total_damage, 300);
        assert_eq!(parser.derived_state.end_time, base + 4_000);

        // No cutoff = the full fight (same as a plain reparse).
        parser.reparse_with_options_window(&[], None, None);
        assert_eq!(parser.derived_state.total_damage, 700);
    }

    #[test]
    fn selection_facts_list_distinct_combinations_only() {
        let mut parser = Parser::default();
        let base = 1_000;
        // Two identical hits plus one different ability, same source and target.
        parser
            .encounter
            .push_event(base, Message::DamageEvent(a_damage_event()));
        parser
            .encounter
            .push_event(base + 10, Message::DamageEvent(a_damage_event()));
        let mut other = a_damage_event();
        other.action_id = ActionType::Normal(777);
        parser
            .encounter
            .push_event(base + 20, Message::DamageEvent(other));

        let (_, assignment) = segment_targets_indexed(&parser.encounter.raw_event_log, base);
        let facts = selection_facts(
            &parser.encounter.raw_event_log,
            base,
            None,
            None,
            &assignment,
        );

        assert_eq!(
            facts.len(),
            2,
            "identical combinations collapse to one fact"
        );
        assert!(facts.iter().any(|f| f.ability == ActionType::Normal(777)));
    }

    /// THE RECYCLED-ID CASE (live: log 1575, "Four Dragons of the Apocalypse").
    ///
    /// The game frees a dead boss's actor index and hands the SAME one to a
    /// later boss: Wilinus Icewyrm and Vrazarek Firewyrm both arrived as index
    /// `3926405961`. `segment_targets` already tells them apart — different max
    /// HP opens a new segment — so a fact must name the SEGMENT it hit, not the
    /// index. Keyed by the index, the two dragons collapsed into one dropdown
    /// entry, one of them vanished from the list entirely, and pinning the
    /// survivor showed the other's damage too.
    #[test]
    fn selection_facts_tell_apart_two_enemies_sharing_a_recycled_index() {
        const WILINUS: u32 = 0xe170_f036;
        const VRAZAREK: u32 = 0x4a29_9e62;
        const RECYCLED: u32 = 3_926_405_961;

        let hit = |ts: i64, enemy: u32, max: u64| {
            let mut event = a_damage_event();
            event.target.index = RECYCLED;
            event.target.parent_index = RECYCLED;
            event.target.parent_actor_type = enemy;
            event.target_current_hp = Some(max / 2);
            event.target_max_hp = Some(max);
            (ts, Message::DamageEvent(event))
        };

        let events = vec![
            hit(0, WILINUS, 900_900_032),
            hit(140_000, WILINUS, 900_900_032),
            hit(280_000, VRAZAREK, 817_537_472),
        ];

        let (segments, assignment) = segment_targets_indexed(&events, 0);
        assert_eq!(segments.len(), 2, "the segmenter already splits them");

        let facts = selection_facts(&events, 0, None, None, &assignment);

        let targets: std::collections::BTreeSet<usize> =
            facts.iter().map(|fact| fact.target_segment).collect();
        assert_eq!(
            targets.len(),
            2,
            "both dragons must be offered; keyed by the recycled index they \
             collapse to one entry and the second dragon disappears"
        );
        assert_eq!(
            targets.into_iter().collect::<Vec<_>>(),
            vec![0, 1],
            "each fact names its own segment, so a pin selects one dragon"
        );
    }

    /// A hit on a phantom marker actor has no segment, so it can never be
    /// offered as a target — the dropdown lists enemies, not markers.
    #[test]
    fn selection_facts_skip_events_with_no_segment() {
        let events = vec![(1_000, Message::DamageEvent(a_damage_event()))];
        let (_, assignment) = segment_targets_indexed(&events, 1_000);
        let facts = selection_facts(&events, 1_000, None, None, &assignment);
        assert_eq!(facts.len(), 1);

        // An assignment that claims nothing belongs to a segment drops the fact
        // rather than inventing one.
        let facts = selection_facts(&events, 1_000, None, None, &[None]);
        assert!(facts.is_empty());
    }

    /// The facts describe the window on screen: an ability used only outside it
    /// must not be offered, or the selector would list a pin that produces an
    /// empty table.
    #[test]
    fn selection_facts_respect_the_window() {
        let mut parser = Parser::default();
        let base = 1_000;

        for (offset, action) in [(0, 1), (5_000, 777)] {
            let mut event = a_damage_event();
            event.action_id = ActionType::Normal(action);
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        let (_, assignment) = segment_targets_indexed(&parser.encounter.raw_event_log, base);
        let facts = selection_facts(
            &parser.encounter.raw_event_log,
            base,
            None,
            Some(2_000),
            &assignment,
        );

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].ability, ActionType::Normal(1));
    }

    /// The selector bar's pins narrow WHOSE damage counts, on the same side of
    /// `extend_window` as the enemy filter: pinning an ability must not shorten
    /// the fight that DPS is divided by, or every metric would silently be
    /// measured over a different span than the one on screen.
    #[test]
    fn selection_narrows_totals_without_moving_the_window() {
        let mut parser = Parser::default();
        let base = 10_000;

        for (offset, damage, action) in [(0, 100, 1), (4_000, 200, 2), (8_000, 400, 1)] {
            let mut event = a_damage_event();
            event.damage = damage;
            event.action_id = ActionType::Normal(action);
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        parser.reparse();
        assert_eq!(parser.derived_state.total_damage, 700);
        let full_end = parser.derived_state.end_time;

        parser.selection = SelectionFilter {
            source_indices: vec![],
            abilities: vec![ActionType::Normal(2)],
        };
        parser.reparse();

        assert_eq!(
            parser.derived_state.total_damage, 200,
            "only the pinned ability counts"
        );
        assert_eq!(
            parser.derived_state.end_time, full_end,
            "the window still spans the whole fight"
        );

        // An unpinned selection restores everything — the raw log is untouched.
        parser.selection = SelectionFilter::default();
        parser.reparse();
        assert_eq!(parser.derived_state.total_damage, 700);
    }

    /// Pinning a source keys on the summoner, so a summon's hit stays with the
    /// player who called it.
    #[test]
    fn selection_by_source_keeps_summon_damage_with_its_owner() {
        let mut parser = Parser::default();
        let base = 10_000;

        let mut own_hit = a_damage_event();
        own_hit.damage = 100;
        parser
            .encounter
            .push_event(base, Message::DamageEvent(own_hit));

        // Same parent, different body: an ordinary summon call.
        let mut summon_hit = a_damage_event();
        summon_hit.damage = 50;
        summon_hit.source.actor_type = 0xB079_2857;
        parser
            .encounter
            .push_event(base + 1_000, Message::DamageEvent(summon_hit));

        parser.selection = SelectionFilter {
            source_indices: vec![0],
            abilities: vec![],
        };
        parser.reparse();

        assert_eq!(parser.derived_state.total_damage, 150);
    }

    /// The two-ended window scrubber: events on both sides of the window are
    /// excluded, and the derived start time moves to the window start so DPS
    /// spans the window, not the whole fight.
    #[test]
    fn reparse_window_excludes_events_outside_both_bounds() {
        let mut parser = Parser::default();
        let base = 10_000;

        for (offset, damage) in [(0, 100), (4_000, 200), (8_000, 400)] {
            let mut event = a_damage_event();
            event.damage = damage;
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        parser.reparse_with_options_window(&[], Some(2_000), Some(5_000));
        assert_eq!(parser.derived_state.total_damage, 200);
        assert_eq!(parser.derived_state.start_time, base + 2_000);
        assert_eq!(parser.derived_state.end_time, base + 4_000);

        // No lower bound = same as the cutoff-only reparse.
        parser.reparse_with_options_window(&[], None, Some(5_000));
        assert_eq!(parser.derived_state.total_damage, 300);
        assert_eq!(parser.derived_state.start_time, base);

        // An empty window stays at zero rather than picking up stale state.
        parser.reparse_with_options_window(&[], Some(1_000), Some(3_000));
        assert_eq!(parser.derived_state.total_damage, 0);
    }

    /// The analysis view's window filter: a multi-window mask with the groups
    /// path's exact semantics — an event is admitted when its fight-relative
    /// timestamp lies inside ANY window (`from_ms <= t < up_to_ms`); `Some`
    /// of an empty vec matches nothing; `None` is no mask at all.
    #[test]
    fn reparse_windows_mask_admits_only_events_inside_a_window() {
        let mut parser = Parser::default();
        let base = 10_000;

        for (offset, damage) in [(0, 100), (4_000, 200), (8_000, 400)] {
            let mut event = a_damage_event();
            event.damage = damage;
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        let mask = [
            TimeWindow {
                from_ms: 0,
                up_to_ms: 1_000,
            },
            TimeWindow {
                from_ms: 3_000,
                up_to_ms: 5_000,
            },
        ];
        parser.reparse_with_options(&[], None, None, Some(&mask));
        // 0 is inside [0,1000); 4_000 inside [3000,5000); 8_000 in neither.
        assert_eq!(parser.derived_state.total_damage, 300);

        // The upper edge is EXCLUSIVE, matching the wire windows' convention.
        let edge = [TimeWindow {
            from_ms: 0,
            up_to_ms: 4_000,
        }];
        parser.reparse_with_options(&[], None, None, Some(&edge));
        assert_eq!(parser.derived_state.total_damage, 100);

        // An empty mask matches nothing — a stale filter narrows, never widens.
        parser.reparse_with_options(&[], None, None, Some(&[]));
        assert_eq!(parser.derived_state.total_damage, 0);

        // The mask composes with the scrub range.
        let wide = [TimeWindow {
            from_ms: 0,
            up_to_ms: 100_000,
        }];
        parser.reparse_with_options(&[], Some(2_000), Some(5_000), Some(&wide));
        assert_eq!(parser.derived_state.total_damage, 200);
    }

    /// The mask gates every accumulation path, not just damage: a stun
    /// message outside every admitted span must not count either.
    #[test]
    fn reparse_windows_mask_drops_non_damage_events_outside_the_mask() {
        let mut parser = Parser::default();
        let base = 10_000;

        // Push in chronological order: the reparse loop's `cutoff` break
        // assumes the raw log is time-ordered.
        let mut damage_event = a_damage_event();
        damage_event.damage = 100;
        parser
            .encounter
            .push_event(base, Message::DamageEvent(damage_event));
        parser.encounter.push_event(
            base + 500,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0xF000_0000,
                stun_amount: 30.0,
            }),
        );
        parser.encounter.push_event(
            base + 2_000,
            Message::OnPlayerStun(OnPlayerStunEvent {
                actor_index: 0xF000_0000,
                stun_amount: 50.0,
            }),
        );

        let mask = [TimeWindow {
            from_ms: 0,
            up_to_ms: 1_000,
        }];
        parser.reparse_with_options(&[], None, None, Some(&mask));

        // The +500 stun message is inside [0,1000) and counts; the +2000 one
        // is outside every admitted span and is dropped, same as a hit.
        assert_eq!(parser.derived_state.total_stun_value, 30.0);
    }

    /// Pins the start-anchoring contract the mask's doc comment describes:
    /// with no scrub `from`, the derived window still anchors on the first
    /// MASK-ADMITTED hit (not the fight's first hit), so backend rates
    /// measure the hull of admitted damage.
    #[test]
    fn reparse_windows_mask_anchors_start_on_first_admitted_hit() {
        let mut parser = Parser::default();
        let base = 10_000;

        for (offset, damage) in [(0, 100), (4_000, 200), (8_000, 400)] {
            let mut event = a_damage_event();
            event.damage = damage;
            parser
                .encounter
                .push_event(base + offset, Message::DamageEvent(event));
        }

        let mask = [TimeWindow {
            from_ms: 3_000,
            up_to_ms: 5_000,
        }];
        parser.reparse_with_options(&[], None, None, Some(&mask));
        assert_eq!(parser.derived_state.start_time, base + 4_000);
    }

    /// Regression: `reparse_with_options_window` swallowed `OnUpdateSBA` in its
    /// `_ => {}` arm, so every STORED log reported `sba = 0.0` for every player
    /// and the analysis view's SBA tab was a list of zeroes. The live path set it;
    /// the reparse the log viewer actually uses never did.
    #[test]
    fn reparse_replays_sba_events() {
        let mut parser = Parser::default();
        // A damage event first: the party row is created from damage, and an SBA
        // event for a player with no row must not be silently dropped.
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.on_sba_update(protocol::OnUpdateSBAEvent {
            actor_index: 0xF000_0000,
            sba_value: 300.0,
            sba_added: 300.0,
        });
        parser.on_sba_update(protocol::OnUpdateSBAEvent {
            actor_index: 0xF000_0000,
            sba_value: 500.0,
            sba_added: 200.0,
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        assert_eq!(player.sba, 500.0, "last gauge value survives a reparse");
        assert_eq!(
            player.sba_generated, 500.0,
            "total generated is the sum of every sba_added"
        );
    }

    /// An attributed gain lands in the same breakdown row the causing hit did, so
    /// the SBA drill-down and the damage drill-down name the same skills.
    #[test]
    fn sba_gain_attributes_to_the_causing_skill_row() {
        let mut parser = Parser::default();
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 1,
            amount: 12.5,
            cause: None,
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("the causing skill's row");
        assert_eq!(row.sba_generated, 12.5);
        // The PLAYER total is NOT touched by a gain — it comes from the gauge poll,
        // which covers all four members; attribution covers only the local player,
        // and adding both would double-count them.
        assert_eq!(
            player.sba_generated, 0.0,
            "a gain splits the total, it does not add to it"
        );
    }

    /// A gain that beats the player's FIRST damage event is held (like the
    /// non-skill sources) and folded through `add_sba_gain` when the row is
    /// created, so it still lands on the causing skill's row. (Distinct from a
    /// gain that beats its own SKILL's first hit, which `PlayerState` holds;
    /// that one only needs the player to exist.)
    #[test]
    fn sba_gain_before_the_players_first_damage_event_is_held() {
        let mut parser = Parser::default();
        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 1,
            amount: 7.0,
            cause: None,
        });

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 1,
            amount: 12.5,
            cause: None,
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("row for the causing skill");
        assert_eq!(
            row.sba_generated,
            7.0 + 12.5,
            "the opener is held for the row, not dropped"
        );
    }

    /// A poll that beats the player's first row-creating event — but lands
    /// inside a running encounter — is held, not dropped: another player's hit
    /// opens the fight, and every member's gauge is polled from that moment
    /// even though their own rows appear one by one.
    #[test]
    fn sba_poll_before_the_players_first_row_is_held() {
        let mut parser = Parser::default();
        let mut opener = a_damage_event();
        opener.source.parent_index = 0xF000_0000;
        parser.on_damage_event(opener);

        parser.on_sba_update(protocol::OnUpdateSBAEvent {
            actor_index: 0xF000_0001,
            sba_value: 150.0,
            sba_added: 150.0,
        });

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0001;
        parser.on_damage_event(event);

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0001)
            .expect("party row");
        assert_eq!(player.sba, 150.0, "the early poll's level survives");
        assert_eq!(
            player.sba_generated, 150.0,
            "the early poll's rise survives"
        );
    }

    /// SBA is a property of the player, not of any hit (see the reparse's SBA
    /// arms) — a source pin must not change anyone's gauge figures. Regression:
    /// polls for a player with no row yet were dropped, and under a source pin
    /// the other players' rows are only created by their first damage-TAKEN
    /// event, so pinning one player visibly changed everyone else's totals.
    #[test]
    fn sba_totals_survive_a_source_pin() {
        let mut parser = Parser::default();
        // The pin filters DEALT events out of the derive; the party the
        // encounter was fought with is stored on it and survives either way,
        // which is what lets the taken hit below open a nameable row.
        parser.encounter.player_data[1] = Some(PlayerData {
            actor_index: 0xF000_0001,
            character_type: CharacterType::from_hash(0x2AF6_78E8),
            ..Default::default()
        });

        let mut pinned = a_damage_event();
        pinned.source.parent_index = 0xF000_0000;
        parser.on_damage_event(pinned);

        // The other player's own hit — filtered out by the pin below.
        let mut other = a_damage_event();
        other.source.parent_index = 0xF000_0001;
        parser.on_damage_event(other);

        parser.on_sba_update(protocol::OnUpdateSBAEvent {
            actor_index: 0xF000_0001,
            sba_value: 300.0,
            sba_added: 300.0,
        });

        // The event that finally creates their row under the pin: an enemy hit
        // ON them (taken events are deliberately not selection-filtered).
        let mut taken = a_damage_event();
        taken.source.parent_actor_type = 0;
        taken.target.parent_index = 0xF000_0001;
        taken.target.parent_actor_type = 0x2AF6_78E8;
        parser.on_damage_event(taken);

        parser.selection = SelectionFilter {
            source_indices: vec![0xF000_0000],
            ..Default::default()
        };
        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0001)
            .expect("row created by the taken hit");
        assert_eq!(player.sba, 300.0, "the poll's level survives the pin");
        assert_eq!(
            player.sba_generated, 300.0,
            "the poll's rise survives the pin"
        );
    }

    fn a_status_apply(status_id: u32) -> protocol::StatusApplyEvent {
        protocol::StatusApplyEvent {
            actor_index: 0xF000_0000,
            caster_index: Some(0xF000_0000),
            status_id,
            ability_id: None,
            stacks: 1,
            status_class: None,
            caster_action_id: None,
        }
    }

    fn recorded_applies(parser: &Parser, status_id: u32) -> usize {
        parser
            .encounter
            .event_log()
            .filter(|(_, m)| matches!(m, Message::StatusApply(e) if e.status_id == status_id))
            .count()
    }

    /// Quest-start buffs (Guts, Autorevive, the sigil passives) land while no
    /// encounter is running, seconds before the first hit. They must survive
    /// the first damage event's `reset()`: the standing map seeds them into
    /// the new encounter's log at its opening event.
    #[test]
    fn statuses_standing_at_encounter_start_are_seeded_into_the_log() {
        let mut parser = Parser::default();
        parser.on_status_apply(a_status_apply(42));

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        assert_eq!(
            recorded_applies(&parser, 42),
            1,
            "the standing buff is seeded at encounter start"
        );
    }

    /// A buff that lapsed before the fight began was not active when it
    /// started, so it is not seeded.
    #[test]
    fn a_status_removed_before_the_encounter_is_not_seeded() {
        let mut parser = Parser::default();
        parser.on_status_apply(a_status_apply(42));
        parser.on_status_remove(protocol::StatusRemoveEvent {
            actor_index: 0xF000_0000,
            status_id: 42,
            ability_id: None,
        });

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        assert_eq!(recorded_applies(&parser, 42), 0);
    }

    /// Repeat Quest chains skip the quest-load boundary and never re-apply the
    /// sigil passives, so the statuses standing when run 1 ended must seed run
    /// 2's encounter as well.
    #[test]
    fn standing_statuses_seed_the_next_chained_encounter() {
        let mut parser = Parser::default();
        parser.on_status_apply(a_status_apply(42));

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event.clone());

        // Run 1 ends at the result screen; a chained run starts WITHOUT a
        // quest load in between.
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 1,
            elapsed_time_in_secs: 60,
        });
        parser.on_damage_event(event);

        assert_eq!(
            recorded_applies(&parser, 42),
            1,
            "run 2's fresh log carries the seeded buff"
        );
    }

    /// A quest load is the standing map's boundary: the incoming area's own
    /// applies fire after it, and anything left from the previous area (a town
    /// buff with no observed remove) must not haunt the next fight.
    #[test]
    fn a_quest_load_clears_the_standing_statuses() {
        let mut parser = Parser::default();
        parser.on_status_apply(a_status_apply(42));

        parser.on_area_enter_event(protocol::AreaEnterEvent {
            last_known_quest_id: 0,
            last_known_elapsed_time_in_secs: 0,
        });

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        assert_eq!(recorded_applies(&parser, 42), 0);
    }

    /// A party award is the whole party's, not the swinging player's: it must
    /// land as a SOURCE even when a hit is on the books.
    #[test]
    fn party_award_lands_as_a_source_not_on_a_skill_row() {
        let mut parser = Parser::default();
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 0,
            amount: 35.0,
            cause: Some(protocol::SbaGainCause::PartyAward),
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        assert_eq!(player.sba_sources.len(), 1);
        assert_eq!(player.sba_sources[0].generated, 35.0);
        assert!(
            player
                .skill_breakdown
                .iter()
                .all(|skill| skill.sba_generated == 0.0),
            "no skill row absorbs a party award"
        );
    }

    /// A gain stored before causes existed keeps its old meaning exactly.
    #[test]
    fn a_causeless_gain_is_read_as_the_hits_own_action() {
        let mut parser = Parser::default();
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 1,
            amount: 12.5,
            cause: None,
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::Normal(1))
            .expect("the causing skill's row");
        assert_eq!(row.sba_generated, 12.5);
        assert!(player.sba_sources.is_empty());
    }

    /// A link attack's gain lands on the link-attack row — the Normal-only
    /// filter that used to drop it is gone, and the row memo is keyed by the
    /// classified action, so nothing has to be flattened.
    #[test]
    fn a_link_attack_gain_lands_on_the_link_attack_row() {
        let mut parser = Parser::default();
        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        event.action_id = ActionType::LinkAttack;
        parser.on_damage_event(event);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 0,
            amount: 9.0,
            cause: Some(protocol::SbaGainCause::Skill(ActionType::LinkAttack)),
        });

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        let row = player
            .skill_breakdown
            .iter()
            .find(|skill| skill.action_type == ActionType::LinkAttack)
            .expect("link attack row");
        assert_eq!(row.sba_generated, 9.0);
    }

    /// A source arriving before ITS OWN player's row exists — the fight already
    /// started off someone else's hit, say an ally bursting before this player
    /// has swung — is HELD against the slot and folded in when the row appears,
    /// rather than dropped.
    ///
    /// A source before the fight's FIRST hit is a different case and stays
    /// dropped: the encounter reset on that hit wipes every pre-fight event,
    /// including the gauge-poll rises the player TOTAL is built from, so
    /// holding the source would explain gauge the total never counted and push
    /// "% explained" past 100.
    #[test]
    fn a_source_arriving_before_the_player_row_is_held() {
        let mut parser = Parser::default();

        // An ally's hit starts the encounter; the gaining player hasn't swung.
        let mut opener = a_damage_event();
        opener.source.parent_index = 0xF000_0001;
        parser.on_damage_event(opener);

        parser.on_sba_gain(protocol::SbaGainEvent {
            actor_index: 0xF000_0000,
            action_id: 0,
            amount: 100.0,
            cause: Some(protocol::SbaGainCause::PartyAward),
        });

        let mut event = a_damage_event();
        event.source.parent_index = 0xF000_0000;
        parser.on_damage_event(event);

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0xF000_0000)
            .expect("party row");
        assert_eq!(
            player.sba_sources.iter().map(|s| s.generated).sum::<f64>(),
            100.0
        );
    }

    /// Regression: the SBA chart walks the FULL event log, so it must size its
    /// buffers from the full log too. Sizing from `derived_state.duration()`
    /// crashed the app on scrub — a cutoff truncates the derived duration, and
    /// any SBA event after the scrub point then indexed past the buffer.
    #[test]
    fn sba_chart_spans_the_full_log_even_with_a_scrub_cutoff() {
        let mut parser = Parser::default();
        let base = 5_000;

        parser
            .encounter
            .push_event(base, Message::DamageEvent(a_damage_event()));
        parser.encounter.push_event(
            base + 10_000,
            Message::OnUpdateSBA(protocol::OnUpdateSBAEvent {
                actor_index: 0,
                sba_value: 250.0,
                sba_added: 250.0,
            }),
        );

        parser.reparse_with_options_window(&[], None, Some(3_000));
        let chart = parser.generate_sba_chart(1_000);

        let row = chart.get(&0).expect("player row");
        assert_eq!(row.len(), 11, "buffer spans the full 10s log");
        assert_eq!(row[10], 250.0, "post-cutoff SBA event lands in its bucket");
    }

    fn room_enter(quest_id: u32, manager_ptr: u64) -> protocol::ConfluxRoomEnterEvent {
        protocol::ConfluxRoomEnterEvent {
            quest_id,
            manager_ptr,
        }
    }

    fn area_enter(quest_id: u32) -> protocol::AreaEnterEvent {
        protocol::AreaEnterEvent {
            last_known_quest_id: quest_id,
            last_known_elapsed_time_in_secs: 0,
        }
    }

    #[test]
    fn trial_end_saves_an_encounter_that_has_damage() {
        // Training has no quest flow, so Quit Training is the ONLY boundary that
        // can close the run — without it the log sat open until the next quest.
        let mut parser = parser_with_memory_db();

        parser.on_damage_event(a_damage_event());
        assert_eq!(parser.status, ParserStatus::InProgress);

        parser.on_trial_end_event();

        assert_eq!(
            parser.status,
            ParserStatus::Stopped,
            "trial end must close the encounter"
        );
        let conn = parser.db.as_ref().unwrap();
        let (count, quest_id): (u32, Option<u32>) = conn
            .query_row("SELECT COUNT(*), quest_id FROM logs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(count, 1, "training run saved at the quit boundary");
        assert_eq!(quest_id, None, "training carries no quest id");
    }

    #[test]
    fn trial_end_on_an_empty_encounter_is_a_no_op() {
        // The quit hook fires up to twice per quit; a repeat must not panic or
        // save an empty encounter.
        let mut parser = parser_with_memory_db();

        parser.on_trial_end_event();
        parser.on_trial_end_event();

        let conn = parser.db.as_ref().unwrap();
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "no damage means nothing to save");
    }

    #[test]
    fn trial_start_closes_the_previous_run_and_opens_a_fresh_one() {
        // The in-training Restart button never runs the quit choke point, so the
        // start/teardown hook is what closes a restarted run.
        let mut parser = parser_with_memory_db();
        parser.on_damage_event(a_damage_event());

        parser.on_trial_start_event();

        {
            let conn = parser.db.as_ref().unwrap();
            let count: u32 = conn
                .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1, "the previous run is saved before restarting");
        }
        assert!(
            parser.encounter.raw_event_log.is_empty(),
            "trial start must open a fresh encounter"
        );
        assert_eq!(parser.derived_state.total_damage, 0);

        // A second restart with nothing recorded since must not save an empty log.
        parser.on_trial_start_event();
        let conn = parser.db.as_ref().unwrap();
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn quest_fail_event_saves_the_encounter_immediately() {
        // The retire/fail hook fires the moment the player confirms retire (or the
        // fail screen shows) — the log must be saved right there, not deferred to
        // the next quest load.
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0xAAAA });

        {
            let conn = parser.db.as_ref().unwrap();
            let (count, quest_id, completed): (u32, Option<u32>, bool) = conn
                .query_row(
                    "SELECT COUNT(*), quest_id, quest_completed FROM logs",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(count, 1, "failed encounter saved at the fail boundary");
            assert_eq!(quest_id, Some(0xAAAA));
            assert!(!completed);
            assert_eq!(parser.status, ParserStatus::Stopped);
        }

        // The next quest load must NOT save the same encounter again.
        parser.on_area_enter_event(area_enter(0xBBBB));
        let conn = parser.db.as_ref().unwrap();
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "boundary cut after a fail save is a no-op");
    }

    #[test]
    fn quest_fail_event_falls_back_to_the_hooks_quest_id() {
        // Injected mid-quest: the encounter never saw its own load, so it has no
        // quest id. The fail event's last-known id fills in; a damage-less
        // encounter saves nothing.
        let mut parser = parser_with_memory_db();

        parser.on_damage_event(a_damage_event());
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0xCCCC });

        {
            let conn = parser.db.as_ref().unwrap();
            let quest_id: Option<u32> = conn
                .query_row("SELECT quest_id FROM logs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(quest_id, Some(0xCCCC));
        }

        // No damage since -> a second fail event must not create an empty log.
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0xCCCC });
        let conn = parser.db.as_ref().unwrap();
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn quest_fail_event_during_conflux_run_is_ignored() {
        // Conflux rooms/runs have their own save boundaries (room-enter /
        // finalize); a retire mid-run must not also save the room as a normal log.
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0x2adb_30e0_100;

        parser.on_conflux_room_enter(room_enter(10, MGR));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0 });

        assert!(parser.active_run_id.is_some(), "run stays active");
        let conn = parser.db.as_ref().unwrap();
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM logs WHERE run_id IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "no normal log saved for a mid-run fail event");
    }

    #[test]
    fn failed_quest_log_keeps_the_quest_it_was_fought_in() {
        // A failed/retired quest emits no result screen; its encounter is cut at the
        // NEXT quest's load. The boundary event's quest id is the INCOMING quest's
        // (the hooked loader reads mgr+0xDC8 to look up the quest being loaded), so
        // stamping it before the save labeled the failed log with the quest that was
        // just started.
        let mut parser = parser_with_memory_db();

        // Quest A loads, takes damage, then fails (nothing emitted).
        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        // Quest B's load fires the boundary cut.
        parser.on_area_enter_event(area_enter(0xBBBB));

        let conn = parser.db.as_ref().unwrap();
        let (quest_id, completed): (Option<u32>, bool) = conn
            .query_row("SELECT quest_id, quest_completed FROM logs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(
            quest_id,
            Some(0xAAAA),
            "failed log carries the quest it was fought in, not the one just started"
        );
        assert!(!completed, "no result screen -> not completed");
        assert_eq!(
            parser.encounter.quest_id,
            Some(0xBBBB),
            "fresh encounter stamped with the incoming quest"
        );
    }

    #[test]
    fn failed_quest_log_does_not_inherit_previous_completions_timer() {
        // quest_timer is only ever written by the type-5 completion path; a later
        // failed quest (saved at the next quest load) must not carry the previous
        // completion's elapsed time.
        let mut parser = parser_with_memory_db();

        // Quest A completes normally with a timer.
        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 213,
        });

        // Quest B loads, takes damage, fails; quest C's load cuts it.
        parser.on_area_enter_event(area_enter(0xBBBB));
        parser.on_damage_event(a_damage_event());
        parser.on_area_enter_event(area_enter(0xCCCC));

        let conn = parser.db.as_ref().unwrap();
        let (quest_id, timer): (Option<u32>, Option<u32>) = conn
            .query_row(
                "SELECT quest_id, quest_elapsed_time FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quest_id, Some(0xBBBB));
        assert_eq!(
            timer, None,
            "failed quest must not inherit quest A's 213s timer"
        );
    }

    /// A Repeat Quest chain never fires the quest-load boundary between runs
    /// (live-confirmed 2026-08-03: one `on_load_quest_state` per chain), so
    /// nothing per-run may rely on `on_area_enter_event` to clear it. The
    /// keep-the-max rule in `record_in_game_time` made every chained run
    /// faster than the slowest-so-far store the stale maximum (nine 142s rows
    /// for 109–137s clears).
    #[test]
    fn chained_repeat_run_stores_its_own_faster_clear_time() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 142,
        });

        // Repeat run: no quest load, damage opens the next encounter directly.
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 109,
        });

        let conn = parser.db.as_ref().unwrap();
        let timer: Option<u32> = conn
            .query_row(
                "SELECT quest_elapsed_time FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            timer,
            Some(109),
            "a chained run must store its own clear time, not the chain's max"
        );
    }

    /// A wipe on a later run of a repeat chain: `quest_completed` and
    /// `quest_timer` were last written by the previous run's completion, and
    /// there is no load boundary in between to clear them.
    #[test]
    fn chained_repeat_wipe_is_not_marked_completed() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 142,
        });

        parser.on_damage_event(a_damage_event());
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0 });

        let conn = parser.db.as_ref().unwrap();
        let (completed, timer): (bool, Option<u32>) = conn
            .query_row(
                "SELECT quest_completed, quest_elapsed_time FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!completed, "a wiped repeat run is not a clear");
        assert_eq!(
            timer, None,
            "a wiped repeat run must not inherit the previous run's clear time"
        );
    }

    /// Runs chained by Repeat Quest are recognisable as exactly the runs that
    /// start without a quest load after a completion; they group under the
    /// chain's first saved run.
    #[test]
    fn repeat_runs_group_under_the_chains_first_run() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        for elapsed in [142, 109, 120] {
            parser.on_damage_event(a_damage_event());
            parser.on_quest_complete_event(protocol::QuestCompleteEvent {
                quest_id: 0xAAAA,
                elapsed_time_in_secs: elapsed,
            });
        }

        let conn = parser.db.as_ref().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, repeat_group FROM logs ORDER BY id")
            .unwrap();
        let rows: Vec<(i64, Option<i64>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].1, None, "the chain's first run is a normal row");
        assert_eq!(rows[1].1, Some(rows[0].0));
        assert_eq!(rows[2].1, Some(rows[0].0));
    }

    /// A quest load is the chain boundary: the next completed quest starts a
    /// fresh group instead of joining the previous one.
    #[test]
    fn a_quest_load_ends_the_repeat_chain() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 142,
        });
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 109,
        });

        // Back to the counter: the next run is not a repeat of the chain.
        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 130,
        });

        let conn = parser.db.as_ref().unwrap();
        let group: Option<i64> = conn
            .query_row(
                "SELECT repeat_group FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(group, None, "a load-started run belongs to no chain");
    }

    /// A wipe mid-chain still happened inside the chain — it joins the group
    /// (and ends it; whatever follows goes through a quest load).
    #[test]
    fn a_wiped_repeat_run_joins_the_group() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 142,
        });

        parser.on_damage_event(a_damage_event());
        parser.on_quest_fail_event(protocol::OnQuestFailEvent { quest_id: 0 });

        let conn = parser.db.as_ref().unwrap();
        let rows: Vec<(i64, Option<i64>)> = {
            let mut stmt = conn
                .prepare("SELECT id, repeat_group FROM logs ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            rows
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].1, Some(rows[0].0), "the wipe belongs to the chain");
    }

    /// Training starts without a quest load, but it is not a repeat of the
    /// quest completed before it.
    #[test]
    fn training_after_a_completion_is_not_part_of_a_chain() {
        let mut parser = parser_with_memory_db();

        parser.on_area_enter_event(area_enter(0xAAAA));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0xAAAA,
            elapsed_time_in_secs: 142,
        });

        parser.on_trial_start_event();
        parser.on_damage_event(a_damage_event());
        parser.on_trial_end_event();

        let conn = parser.db.as_ref().unwrap();
        let group: Option<i64> = conn
            .query_row(
                "SELECT repeat_group FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(group, None, "a training session joins no quest chain");
    }

    #[test]
    fn conflux_run_cleared_via_result_screen_then_town_exit() {
        // The manager dtor rarely fires; the common end of a CLEARED run is a type-5
        // result screen mid-run followed by exiting to town (area-enter). That exit
        // path passes completed=false, but the observed result screen must win.
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0x2adb_30e0_100;

        parser.on_conflux_room_enter(room_enter(10, MGR));
        parser.on_damage_event(a_damage_event());

        // Final room cleared: genuine quest-complete result screen fires mid-run.
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0x2231_B940,
            elapsed_time_in_secs: 900,
        });
        assert!(
            parser.active_run_id.is_some(),
            "result screen must not end/save the run itself"
        );

        // Back to town — the path that used to mark the run ✗.
        parser.on_area_enter_event(area_enter(0xAAAA));
        assert!(
            parser.active_run_id.is_none(),
            "run closed by leaving Conflux"
        );

        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            runs[0].completed,
            Some(true),
            "mid-run result screen marks the run cleared"
        );
        // Only the room log exists — the completion must not also save a normal log.
        let log_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(log_count, 1);
        assert!(!parser.active_run_completed, "flag reset for the next run");
    }

    #[test]
    fn conflux_run_lifecycle_groups_rooms_and_buffs() {
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0x2adb_30e0_100;

        // First room-enter (same manager for the whole run) OPENS the run.
        parser.on_conflux_room_enter(room_enter(10, MGR));
        assert!(parser.active_run_id.is_some());
        assert_eq!(parser.active_run_manager, MGR);

        // Room 0: some damage + buffs.
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xAA });
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xAA }); // dup

        // Room 1 (same manager): saves room 0, advances.
        parser.on_conflux_room_enter(room_enter(11, MGR));
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_buff_acquired(protocol::ConfluxBuffAcquiredEvent { buff_id: 0xCC });

        // Manager dtor ends the run (saves room 1).
        parser.on_conflux_run_end(protocol::ConfluxRunEndEvent { manager_ptr: MGR });
        assert!(parser.active_run_id.is_none(), "run cleared after end");

        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(
            runs.len(),
            1,
            "exactly ONE run for the whole 2-room sequence"
        );
        let run = &runs[0];
        assert_eq!(run.rooms.len(), 2, "two rooms saved and tagged to the run");
        assert_eq!(run.rooms[0].room_index, 0);
        assert_eq!(run.rooms[1].room_index, 1);
        assert_eq!(run.completed, Some(true));
        let r0 = run.buffs.iter().find(|b| b.room_index == 0).unwrap();
        assert_eq!(r0.buff_ids, vec![0xAA]);
        let r1 = run.buffs.iter().find(|b| b.room_index == 1).unwrap();
        assert_eq!(r1.buff_ids, vec![0xCC]);
    }

    fn identity_event(
        name: &str,
        character_type: u32,
        party_index: u8,
        actor_index: u32,
        is_online: bool,
    ) -> PlayerIdentityEvent {
        let name = std::ffi::CString::new(name).unwrap();
        PlayerIdentityEvent {
            character_name: name.clone(),
            display_name: name,
            character_type,
            party_index,
            actor_index,
            is_online,
            sigils: Vec::new(),
            summons: Vec::new(),
            overmasteries: Vec::new(),
            player_level: 0,
            abilities: Vec::new(),
            weapon_key: String::new(),
            master_level: 0,
            skillboard: Vec::new(),
            stats: None,
            weapon_state: None,
            cap_up_normal: None,
            cap_up_skill: None,
            cap_up_sba: None,
        }
    }

    #[test]
    fn ai_companion_identities_are_saved_to_player_columns() {
        // Single-player + 3 AI companions: the hook claims the AI slot records with
        // BLANKED names (their snapshots carry the local profile's name) and emits an
        // identity event before each actor's damage. The saved log row must carry all
        // four slots' character types — this is the logs-table "Name" column showing
        // one entry instead of four.
        let mut parser = parser_with_memory_db();

        // (character hash, party slot, actor index, display name) — hashes as captured
        // live on v2.0.2: Eustace local + Zeta/Ferry/Cagliostro-style AI companions.
        let party: [(u32, u8, u32, &str); 4] = [
            (0x91418145, 0, 4_217_578_216, "Manmoth"),
            (0x6FDD6932, 1, 4_214_090_008, ""),
            (0x443D46BB, 2, 4_215_158_024, ""),
            (0xC3155079, 3, 4_217_362_552, ""),
        ];

        for (character_type, party_index, actor_index, name) in party {
            parser.on_player_identity_event(identity_event(
                name,
                character_type,
                party_index,
                actor_index,
                false,
            ));

            let mut event = a_damage_event();
            event.source = Actor {
                index: actor_index,
                actor_type: character_type,
                parent_actor_type: character_type,
                parent_index: actor_index,
            };
            parser.on_damage_event(event);
        }

        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 0x22A060,
            elapsed_time_in_secs: 213,
        });

        let conn = parser.db.as_ref().unwrap();
        let row = conn
            .query_row(
                "SELECT p1_name, p1_type, p2_name, p2_type, p3_type, p4_type,
                        quest_id, quest_elapsed_time
                 FROM logs ORDER BY id DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<u32>>(6)?,
                        row.get::<_, Option<u32>>(7)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(row.0.as_deref(), Some("Manmoth"));
        assert_eq!(row.1.as_deref(), Some("Pl2700"));
        // AI slots: blank name (frontend renders "(AI)"), character type present.
        assert_eq!(row.2.as_deref(), Some(""));
        assert_eq!(row.3.as_deref(), Some("Pl1800"));
        assert_eq!(row.4.as_deref(), Some("Pl0500"));
        assert_eq!(row.5.as_deref(), Some("Pl1600"));
        assert_eq!(row.6, Some(0x22A060));
        assert_eq!(row.7, Some(213));
    }

    #[test]
    fn identity_events_slot_players_by_party_index() {
        // v2.0.2: actor_index is a pointer-like value with no meaningful order, and the
        // LOCAL player is flagged is_online in a lobby. The party slot from the identity
        // snapshot is the only stable position — player_data[N] must be party slot N.
        let mut parser = Parser::default();

        parser.on_player_identity_event(identity_event(
            "Alice",
            0x8056ABCD,
            2,
            4_215_158_024,
            true,
        ));
        parser.on_player_identity_event(identity_event("Bob", 0x2AF678E8, 0, 4_208_915_704, true));

        let slot0 = parser.encounter.player_data[0]
            .as_ref()
            .expect("online local player still lands in slot 0");
        assert_eq!(slot0.display_name, "Bob");
        let slot2 = parser.encounter.player_data[2]
            .as_ref()
            .expect("party slot 2 player lands in slot 2");
        assert_eq!(slot2.display_name, "Alice");
        assert!(parser.encounter.player_data[1].is_none());
        assert!(parser.encounter.player_data[3].is_none());

        // Same slot re-announced under a new actor index (id churn between quests)
        // replaces the entry instead of duplicating the player into another slot.
        parser.on_player_identity_event(identity_event("Alice", 0x8056ABCD, 2, 999, true));
        let slot2 = parser.encounter.player_data[2].as_ref().unwrap();
        assert_eq!(slot2.actor_index, 999);
        assert_eq!(parser.encounter.player_data.iter().flatten().count(), 2);
    }

    fn a_weapon_state(weapon_id: u32) -> protocol::WeaponState {
        protocol::WeaponState {
            weapon_id,
            exp: 0,
            star_level: 0,
            plus_marks: 0,
            awakening_level: 0,
            wrightstone_id: 0,
            wrightstone_traits: Vec::new(),
            innate_traits: Vec::new(),
        }
    }

    fn identity_event_with_weapon(state: protocol::WeaponState) -> PlayerIdentityEvent {
        let mut event = identity_event("ふみ", 0x2AF678E8, 1, 42, true);
        event.weapon_state = Some(state);
        event
    }

    #[test]
    fn sparse_weapon_state_refresh_keeps_recovered_fields() {
        // Online quests: identity refreshes re-read the record while the remote
        // player's network sync is still partial, and the stored state was
        // last-write-wins — one late sparse read wiped awakening, innate skills
        // and the wrightstone an earlier read had recovered (Jumbo Crab log 542).
        let mut parser = Parser::default();

        let mut full = a_weapon_state(0xCB5A08CD);
        full.exp = 162_540;
        full.star_level = 6;
        full.awakening_level = 10;
        full.wrightstone_id = 0x667E_E1D3;
        full.wrightstone_traits = vec![protocol::WeaponTraitPair {
            id: 0xF372_F096,
            level: 20,
        }];
        full.innate_traits = vec![protocol::WeaponTraitPair {
            id: 0x1E1C_ECCE,
            level: 35,
        }];
        parser.on_player_identity_event(identity_event_with_weapon(full));

        let mut sparse = a_weapon_state(0xCB5A08CD);
        sparse.plus_marks = 99; // the one field the partial read carried
        parser.on_player_identity_event(identity_event_with_weapon(sparse));

        let player = parser.encounter.player_data[1].as_ref().unwrap();
        let state = player.weapon_state.as_ref().unwrap();
        assert_eq!(state.awakening_level, 10);
        assert_eq!(state.star_level, 6);
        assert_eq!(state.plus_marks, 99, "new fields still fold in");
        assert_eq!(state.wrightstone_id, 0x667E_E1D3);
        assert_eq!(state.wrightstone_traits.len(), 1);
        assert_eq!(
            state.innate_traits,
            vec![WeaponTraitPair {
                id: 0x1E1C_ECCE,
                level: 35,
            }]
        );
    }

    #[test]
    fn leveled_innate_skills_beat_an_unleveled_refresh() {
        // A refresh can carry the innate skill IDS but no levels (the level pair
        // array reads zero when the id lookup misses) — that read must not
        // replace a previously recovered leveled set, but a leveled one may.
        let mut parser = Parser::default();

        let mut leveled = a_weapon_state(0xCB5A08CD);
        leveled.innate_traits = vec![protocol::WeaponTraitPair {
            id: 0x1E1C_ECCE,
            level: 35,
        }];
        parser.on_player_identity_event(identity_event_with_weapon(leveled));

        let mut unleveled = a_weapon_state(0xCB5A08CD);
        unleveled.innate_traits = vec![protocol::WeaponTraitPair {
            id: 0x1E1C_ECCE,
            level: 0,
        }];
        parser.on_player_identity_event(identity_event_with_weapon(unleveled));

        let player = parser.encounter.player_data[1].as_ref().unwrap();
        let state = player.weapon_state.as_ref().unwrap();
        assert_eq!(state.innate_traits[0].level, 35);
    }

    #[test]
    fn a_different_weapon_id_replaces_the_state_wholesale() {
        // A different weapon id is a real re-equip (lobby loadout change), not a
        // partial read — carrying the old weapon's fields over would fabricate
        // a hybrid loadout.
        let mut parser = Parser::default();

        let mut old = a_weapon_state(0xCB5A08CD);
        old.awakening_level = 10;
        old.wrightstone_id = 0x667E_E1D3;
        parser.on_player_identity_event(identity_event_with_weapon(old));

        let new = a_weapon_state(0xE3B3_5C0D);
        parser.on_player_identity_event(identity_event_with_weapon(new));

        let player = parser.encounter.player_data[1].as_ref().unwrap();
        let state = player.weapon_state.as_ref().unwrap();
        assert_eq!(state.weapon_id, 0xE3B3_5C0D);
        assert_eq!(state.awakening_level, 0);
        assert_eq!(state.wrightstone_id, 0);
    }

    #[test]
    fn encounter_reset_clears_stale_player_data() {
        // v2.0.2: the area-enter hook is dead, so nothing wiped player_data between
        // quests — stale names attached to reused actor indices. The encounter reset
        // (first damage after a Stopped encounter) must clear it; live identity events
        // repopulate it immediately.
        let mut parser = parser_with_memory_db();

        parser.on_player_identity_event(identity_event("Old", 0x8056ABCD, 1, 111, true));
        parser.on_damage_event(a_damage_event());
        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 1,
            elapsed_time_in_secs: 10,
        });

        parser.on_damage_event(a_damage_event());
        assert!(
            parser.encounter.player_data.iter().all(Option::is_none),
            "player_data cleared when a new encounter starts"
        );
    }

    #[test]
    fn dragon_form_damage_attributes_to_the_id_player() {
        // v2.0.2: the Pl2000->Pl1900 parent link is unrecoverable in the hook, so
        // dragon-form events arrive parented to themselves. The parser must merge
        // them into the party's Id (Pl1900) player instead of a separate row.
        let mut parser = parser_with_memory_db();

        parser.on_player_identity_event(identity_event("IdPlayer", 0x8056ABCD, 0, 100, false));

        let mut event = a_damage_event();
        event.source = Actor {
            index: 200,
            actor_type: 0xF5755C0E,
            parent_actor_type: 0xF5755C0E,
            parent_index: 200,
        };
        parser.on_damage_event(event);

        let party = &parser.derived_state.party;
        assert_eq!(party.len(), 1, "dragon form must not get its own row");
        let player = party.get(&100).expect("damage attributed to the Id player");
        assert_eq!(player.character_type, CharacterType::Pl1900);
        assert_eq!(player.total_damage, 500);
    }

    #[test]
    fn dragon_identity_populates_an_empty_slot_as_id() {
        // A recruited crewmate Id fights entirely as its Pl2000 dragon actor — the
        // Pl1900 base actor may never deal a hit, so dragon-sourced identity events
        // are the ONLY ones that ever arrive for that player (live logs 344-346,
        // 2026-07-23: slot 4 stayed empty for the whole quest). They must fill the
        // slot as the Id player instead of being dropped.
        let mut parser = Parser::default();

        parser.on_player_identity_event(identity_event(
            "IdRecruit",
            0xF5755C0E,
            3,
            0xF000_0003,
            true,
        ));

        let slot = parser.encounter.player_data[3]
            .as_ref()
            .expect("dragon-form identity fills the recruit's empty slot");
        assert_eq!(slot.character_type, CharacterType::Pl1900);
        assert_eq!(slot.display_name, "IdRecruit");
    }

    #[test]
    fn dragon_identity_updates_each_id_players_own_slot() {
        // Two Ids in the party (e.g. a real Id player plus a recruited crewmate Id):
        // each dragon actor resolves to its own party slot, so dragon identity events
        // must stay slot-scoped and never merge or cross-claim the other Id's entry.
        let mut parser = Parser::default();

        parser.on_player_identity_event(identity_event(
            "LocalId",
            0x8056ABCD,
            0,
            0xF000_0000,
            false,
        ));
        parser.on_player_identity_event(identity_event(
            "RecruitId",
            0xF5755C0E,
            3,
            0xF000_0003,
            true,
        ));
        // The local Id transforms mid-quest: its own dragon identity refresh.
        parser.on_player_identity_event(identity_event(
            "LocalId",
            0xF5755C0E,
            0,
            0xF000_0000,
            false,
        ));

        let slot0 = parser.encounter.player_data[0].as_ref().unwrap();
        assert_eq!(slot0.character_type, CharacterType::Pl1900);
        assert_eq!(slot0.display_name, "LocalId");
        let slot3 = parser.encounter.player_data[3].as_ref().unwrap();
        assert_eq!(slot3.character_type, CharacterType::Pl1900);
        assert_eq!(slot3.display_name, "RecruitId");
        assert_eq!(parser.encounter.player_data.iter().flatten().count(), 2);
    }

    #[test]
    fn dragon_identity_never_claims_another_characters_slot() {
        // Defensive: if a dragon-form event ever arrives carrying a party slot that
        // a different character already owns (a bad embedded-record read), it must
        // not overwrite that player.
        let mut parser = Parser::default();

        parser.on_player_identity_event(identity_event(
            "Manmoth",
            0x91418145,
            3,
            0xF000_0003,
            false,
        ));
        parser.on_player_identity_event(identity_event(
            "IdRecruit",
            0xF5755C0E,
            3,
            0xF000_0003,
            true,
        ));

        let slot = parser.encounter.player_data[3].as_ref().unwrap();
        assert_eq!(slot.character_type, CharacterType::Pl2700);
        assert_eq!(slot.display_name, "Manmoth");
    }

    fn a_player_load_event(
        name: &str,
        character_type: u32,
        party_index: u8,
        actor_index: u32,
    ) -> PlayerLoadEvent {
        let name = std::ffi::CString::new(name).unwrap();
        PlayerLoadEvent {
            sigils: Vec::new(),
            character_name: name.clone(),
            display_name: name,
            character_type,
            party_index,
            actor_index,
            is_online: false,
            weapon_info: protocol::WeaponInfo {
                weapon_id: 0,
                star_level: 0,
                plus_marks: 0,
                awakening_level: 0,
                trait_1_id: 0,
                trait_1_level: 0,
                trait_2_id: 0,
                trait_2_level: 0,
                trait_3_id: 0,
                trait_3_level: 0,
                wrightstone_id: 0,
                weapon_level: 0,
                weapon_hp: 0,
                weapon_attack: 0,
            },
            overmastery_info: protocol::OvermasteryInfo {
                overmasteries: Vec::new(),
            },
            player_stats: protocol::PlayerStats {
                level: 0,
                total_hp: 0,
                total_attack: 0,
                stun_power: 0.0,
                critical_rate: 0.0,
                total_power: 0,
            },
        }
    }

    #[test]
    fn dragon_player_load_populates_the_slot_as_id() {
        // Same rule on the legacy full player-load path: a Pl2000 load event fills
        // an empty slot as the Id player instead of being dropped, and never
        // overwrites a slot another character owns.
        let mut parser = Parser::default();

        parser.on_player_load_event(a_player_load_event("IdRecruit", 0xF5755C0E, 3, 0xF000_0003));
        let slot = parser.encounter.player_data[3]
            .as_ref()
            .expect("dragon-form load fills the recruit's empty slot");
        assert_eq!(slot.character_type, CharacterType::Pl1900);

        parser.on_player_load_event(a_player_load_event("Manmoth", 0x91418145, 0, 0xF000_0000));
        parser.on_player_load_event(a_player_load_event("IdRecruit", 0xF5755C0E, 0, 0xF000_0000));
        let slot0 = parser.encounter.player_data[0].as_ref().unwrap();
        assert_eq!(
            slot0.character_type,
            CharacterType::Pl2700,
            "dragon load must not claim another character's slot"
        );
    }

    #[test]
    fn equipment_fields_persist_across_sparse_refresh() {
        // v2.0.2 expansion equipment: abilities/weapon/master-level/skillboard
        // arrive on a fully-resolved identity refresh; a later sparse refresh
        // (save not yet loaded, or a remote player with no local save data)
        // carries none and must not wipe the learned values.
        let mut parser = parser_with_memory_db();

        let mut full = identity_event("Manmoth", 0x8056ABCD, 0, 100, false);
        full.abilities = vec![0x1111_2222, 0x3333_4444];
        full.weapon_key = "WEP_PL2700_02_01".to_string();
        full.master_level = 55;
        full.skillboard = vec![0xAAAA_0001, 0xAAAA_0002, 0xAAAA_0003];
        parser.on_player_identity_event(full);

        // Sparse refresh: everything default.
        parser.on_player_identity_event(identity_event("Manmoth", 0x8056ABCD, 0, 100, false));

        let slot = parser.encounter.player_data[0].as_ref().unwrap();
        assert_eq!(slot.abilities, vec![0x1111_2222, 0x3333_4444]);
        assert_eq!(slot.weapon_key, "WEP_PL2700_02_01");
        assert_eq!(slot.master_level, 55);
        assert_eq!(slot.skillboard.len(), 3);
    }

    #[test]
    fn town_overmasteries_and_level_persist_across_empty_inquest_refresh() {
        // v2.0.2: overmasteries + level come from the town loadout, which is NULL
        // in-quest — so an in-quest identity refresh carries none. The town-sighting
        // values must survive that empty refresh (mirrors the sigil/summon merge).
        let mut parser = parser_with_memory_db();

        // Town refresh: id + level_bits (bit 6 -> level 7) and character level 100.
        let mut town = identity_event("Manmoth", 0x8056ABCD, 0, 100, false);
        town.overmasteries = vec![protocol::Overmastery {
            id: 0x9A97C049,
            flags: 0x40,
            value: 0.0,
        }];
        town.player_level = 100;
        parser.on_player_identity_event(town);

        let slot = parser.encounter.player_data[0].as_ref().unwrap();
        assert_eq!(slot.player_stats.as_ref().unwrap().level, 100);
        let om = &slot.overmastery_info.as_ref().unwrap().overmasteries;
        assert_eq!(om.len(), 1);
        assert_eq!(om[0].id, 0x9A97C049);
        assert_eq!(om[0].flags, 0x40);

        // In-quest refresh for the same slot with no loadout data must NOT wipe them.
        parser.on_player_identity_event(identity_event("Manmoth", 0x8056ABCD, 0, 100, false));

        let slot = parser.encounter.player_data[0].as_ref().unwrap();
        assert_eq!(slot.player_stats.as_ref().unwrap().level, 100);
        assert_eq!(
            slot.overmastery_info.as_ref().unwrap().overmasteries.len(),
            1,
            "town overmasteries survive an empty in-quest refresh"
        );
    }

    #[test]
    fn repeated_room_enter_same_manager_is_one_run_not_many() {
        // Regression for the live bug: the reception dispatcher fires once PER ROOM, so
        // four room-enters with the SAME manager must produce ONE run, not four.
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0xABCD_0000_100;

        for room in 0..4 {
            parser.on_conflux_room_enter(room_enter(100 + room, MGR));
            parser.on_damage_event(a_damage_event());
        }
        parser.on_conflux_run_end(protocol::ConfluxRunEndEvent { manager_ptr: MGR });

        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1, "one run");
        assert_eq!(runs[0].rooms.len(), 4, "four rooms grouped under it");
    }

    #[test]
    fn leaving_to_normal_area_finalizes_active_run() {
        // Regression for the live bug: a run played and then exited to town (no dtor, no next
        // run) was left active forever, so its row kept room_count=0 / null duration/completed.
        // on_area_enter_event must finalize it.
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0xFEED_0000_100;

        for room in 0..3 {
            parser.on_conflux_room_enter(room_enter(100 + room, MGR));
            parser.on_damage_event(a_damage_event());
        }
        // Leave Conflux for a normal area — no dtor fires.
        parser.on_area_enter_event(protocol::AreaEnterEvent {
            last_known_quest_id: 0,
            last_known_elapsed_time_in_secs: 0,
        });

        assert!(parser.active_run_id.is_none(), "run cleared after leaving");
        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].room_count, 3, "all three rooms counted");
        assert_eq!(runs[0].rooms.len(), 3);
        assert!(runs[0].duration.is_some(), "duration written");
        assert_eq!(runs[0].completed, Some(false), "left, not reward-completed");
    }

    #[test]
    fn live_cap_counts_use_exact_base_over_cap() {
        // Exact detection (base > cap) is correct per-hit with no learning phase, so
        // the live counts are final immediately — no convergence pass at quest end.
        // A hit is capped iff its pre-cap base exceeds the cap, regardless of the
        // final (post-crit) damage number.
        let mut parser = parser_with_memory_db();

        let cap_event = |base: f32, skill: u32| {
            let mut e = a_damage_event();
            e.action_id = ActionType::Normal(skill);
            e.damage = 1000; // final number is irrelevant to cap detection now
            e.damage_cap = Some(1000);
            e.base_damage = Some(base);
            e
        };

        // 100 hits whose base exceeds the cap -> capped.
        for i in 0..100u32 {
            parser.on_damage_event(cap_event(1500.0, 1 + i % 2));
        }
        // 10 hits whose base is at or under the cap -> NOT capped (cappable though).
        for _ in 0..10 {
            parser.on_damage_event(cap_event(900.0, 1));
        }

        parser.on_quest_complete_event(protocol::QuestCompleteEvent {
            quest_id: 1,
            elapsed_time_in_secs: 10,
        });

        let player = parser.derived_state.party.get(&0).unwrap();
        assert_eq!(
            player.cappable_hits, 110,
            "denominator counts all capped-capable hits"
        );
        assert_eq!(
            player.capped_hits, 100,
            "only base>cap hits count as capped"
        );
        let (skill_capped, skill_cappable) =
            player.skill_breakdown.iter().fold((0, 0), |acc, s| {
                (acc.0 + s.capped_hits, acc.1 + s.cappable_hits)
            });
        assert_eq!(skill_cappable, 110);
        assert_eq!(skill_capped, 100);

        // Overcap %: 100 hits at base 1500/cap 1000 + 10 at 900/1000.
        // Σbase = 100*1500 + 10*900 = 159_000; Σcap = 110*1000 = 110_000.
        assert_eq!(player.overcap_base_sum, 159_000.0);
        assert_eq!(player.overcap_cap_sum, 110_000.0);
    }

    #[test]
    fn game_disconnect_saves_in_progress_encounter() {
        // Abandoning a quest emits NO result screen, and quitting the game right
        // after means no next quest load ever fires the boundary cut. The pipe
        // disconnect is the last chance to save — the parser is dropped after it.
        let mut parser = parser_with_memory_db();

        parser.on_damage_event(a_damage_event());
        parser.on_game_disconnect();

        let conn = parser.db.as_ref().unwrap();
        let (count, completed): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(quest_completed), 0) FROM logs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "in-progress encounter saved on game close");
        assert_eq!(completed, 0, "not marked completed");
    }

    #[test]
    fn game_disconnect_finalizes_active_conflux_run() {
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0x4444_0000_100;

        parser.on_conflux_room_enter(room_enter(1, MGR));
        parser.on_damage_event(a_damage_event());
        parser.on_game_disconnect();

        assert!(parser.active_run_id.is_none(), "run closed out");
        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].rooms.len(), 1, "in-progress room saved");
        assert_eq!(runs[0].completed, Some(false), "quit, not reward-completed");
    }

    #[test]
    fn leftover_normal_encounter_saved_before_conflux_run_starts() {
        // A normal quest that ends with no result screen (fail/retire) leaves an
        // InProgress encounter behind, and the hook's quest-load boundary cut is
        // deliberately suppressed on Conflux room loads. Entering a run must
        // therefore save the leftover as a normal log itself — otherwise its
        // damage merges into room 1.
        let mut parser = parser_with_memory_db();
        const MGR: u64 = 0x3333_0000_100;

        parser.on_damage_event(a_damage_event());

        parser.on_conflux_room_enter(room_enter(1, MGR));
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_run_end(protocol::ConfluxRunEndEvent { manager_ptr: MGR });

        let conn = parser.db.as_ref().unwrap();
        let (normal_logs, normal_damage): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(total_damage), 0) FROM logs WHERE run_id IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            normal_logs, 1,
            "leftover normal encounter saved as its own log"
        );
        assert_eq!(normal_damage, 500, "room damage not merged into it");
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            runs[0].rooms.len(),
            1,
            "room 1 saved separately under the run"
        );
    }

    #[test]
    fn different_manager_opens_a_new_run() {
        let mut parser = parser_with_memory_db();
        const MGR_A: u64 = 0x1111_0000_100;
        const MGR_B: u64 = 0x2222_0000_100;

        // Run A: one room with damage.
        parser.on_conflux_room_enter(room_enter(1, MGR_A));
        parser.on_damage_event(a_damage_event());

        // A new manager arrives WITHOUT a dtor — should finalize run A and open run B.
        parser.on_conflux_room_enter(room_enter(2, MGR_B));
        parser.on_damage_event(a_damage_event());
        parser.on_conflux_run_end(protocol::ConfluxRunEndEvent { manager_ptr: MGR_B });

        let conn = parser.db.as_ref().unwrap();
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 2, "two distinct runs");
    }

    #[test]
    fn can_create_parser() {
        let parser = Parser::default();

        assert_eq!(parser.status, ParserStatus::Stopped);
        assert_eq!(parser.start_time(), 1);
    }

    #[test]
    fn start_time_depends_on_first_event() {
        let mut parser = Parser::default();

        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: 0,
                flags: 0,
                action_id: ActionType::Normal(0),
                attack_rate: None,
                stun_value: None,
                damage_cap: None,
                base_damage: None,
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }),
        ));

        assert_eq!(parser.start_time(), 1_000);
    }

    #[test]
    fn duration_calculated_from_start_to_current_event() {
        let mut parser = Parser::default();

        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: 0,
                flags: 0,
                action_id: ActionType::Normal(0),
                attack_rate: None,
                stun_value: None,
                damage_cap: None,
                base_damage: None,
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }),
        ));

        parser.encounter.raw_event_log.push((
            5_000,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: 0,
                flags: 0,
                action_id: ActionType::Normal(0),
                attack_rate: None,
                stun_value: None,
                damage_cap: None,
                base_damage: None,
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }),
        ));

        parser.reparse();

        assert_eq!(parser.derived_state.start_time, 1_000);
        assert_eq!(parser.derived_state.end_time, 5_000);
        assert_eq!(parser.derived_state.duration(), 4_000);
    }

    #[test]
    fn capped_hits_aggregated_through_reparse() {
        let mut parser = Parser::default();

        // A hit that reached its cap, followed by one that did not.
        parser.encounter.raw_event_log.push((
            1_000,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: 99_999,
                flags: 0,
                action_id: ActionType::Normal(1),
                attack_rate: None,
                stun_value: None,
                damage_cap: Some(99_999),
                base_damage: Some(200_000.0), // base > cap -> capped
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }),
        ));

        parser.encounter.raw_event_log.push((
            2_000,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: 100,
                flags: 0,
                action_id: ActionType::Normal(1),
                attack_rate: None,
                stun_value: None,
                damage_cap: Some(99_999),
                base_damage: Some(100.0), // base < cap -> not capped
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }),
        ));

        parser.reparse();

        let player = parser
            .derived_state
            .party
            .get(&0)
            .expect("player should be present after reparse");
        assert_eq!(player.capped_hits, 1);
        assert_eq!(player.skill_breakdown.len(), 1);
        assert_eq!(player.skill_breakdown[0].capped_hits, 1);
        assert_eq!(player.skill_breakdown[0].hits, 2);
    }

    #[test]
    fn reparse_uses_exact_base_over_cap_detection() {
        fn dmg_event(base: f32, cap: i32, skill: u32) -> DamageEvent {
            DamageEvent {
                source: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                target: Actor {
                    index: 0,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 0,
                },
                damage: cap, // final number irrelevant to cap detection
                flags: 0,
                action_id: ActionType::Normal(skill),
                attack_rate: None,
                stun_value: None,
                damage_cap: Some(cap),
                base_damage: Some(base),
                target_current_hp: None,
                target_max_hp: None,
                class_flags: None,
            }
        }

        let mut parser = Parser::default();
        let cap = 1000;
        let mut ts = 0i64;
        let mut push = |parser: &mut Parser, base: f32, skill: u32| {
            ts += 1;
            parser
                .encounter
                .raw_event_log
                .push((ts, Message::DamageEvent(dmg_event(base, cap, skill))));
        };

        // 100 hits whose pre-cap base exceeds the cap -> capped.
        for i in 0..100u32 {
            push(&mut parser, 1500.0, 1 + i % 2);
        }
        // One hit whose base is exactly at the cap -> NOT over the cap.
        push(&mut parser, 1000.0, 1);

        parser.reparse();

        let player = parser.derived_state.party.get(&0).expect("player present");
        let total_hits: u32 = player.skill_breakdown.iter().map(|s| s.hits).sum();
        assert_eq!(total_hits, 101);
        assert_eq!(player.capped_hits, 100, "base==cap hit is not capped");

        // Overcap %: Σbase = 100*1500 + 1000 = 151_000; Σcap = 101*1000.
        assert_eq!(player.overcap_base_sum, 151_000.0);
        assert_eq!(player.overcap_cap_sum, 101_000.0);
    }
}

/// Stored logs are CBOR (see [`Encounter::to_blob`]), which keys every struct
/// field by NAME — so renaming a field silently breaks every log already on
/// disk unless the new name is optional. Bincode, the hook→parser wire, hides
/// this: it is positional, and hook and parser ship together, so a rename that
/// round-trips fine there can still be unreadable on disk. These tests pin the
/// stored shapes real logs were written with.
#[cfg(test)]
mod stored_log_compat {
    use serde::Serialize;

    /// The parser's `RecordStats` as written before 2026-07-24, when
    /// `unk_58: u32` was renamed to `critical_rate: f32`. `rename_all` matches
    /// the real struct, so these are the keys that are actually on disk.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OldParserRecordStats {
        level: u32,
        hp: u32,
        attack: u32,
        unk_50: u32,
        stun_power: f32,
        unk_58: u32,
        power: u32,
    }

    /// The same block as the protocol carries it inside `raw_event_log`'s
    /// identity messages — no `rename_all` there, so its keys differ.
    #[derive(Serialize)]
    struct OldProtocolRecordStats {
        level: u32,
        hp: u32,
        attack: u32,
        unk_50: u32,
        stun_power: f32,
        unk_58: u32,
        power: u32,
    }

    fn old_parser_stats() -> OldParserRecordStats {
        OldParserRecordStats {
            level: 10,
            hp: 5000,
            attack: 3000,
            unk_50: 0,
            stun_power: 12.5,
            // The game writes an f32 here; the old reader stored its raw bits.
            unk_58: 21.5f32.to_bits(),
            power: 9999,
        }
    }

    fn old_protocol_stats() -> OldProtocolRecordStats {
        OldProtocolRecordStats {
            level: 10,
            hp: 5000,
            attack: 3000,
            unk_50: 0,
            stun_power: 12.5,
            unk_58: 21.5f32.to_bits(),
            power: 9999,
        }
    }

    #[test]
    fn pre_rename_parser_record_stats_still_loads() {
        let blob = cbor4ii::serde::to_vec(Vec::new(), &old_parser_stats()).expect("serialize");

        let stats: super::RecordStats = cbor4ii::serde::from_slice(&blob).expect("deserialize");

        assert_eq!(stats.level, 10);
        assert_eq!(stats.stun_power, 12.5);
        assert_eq!(stats.power, 9999);
        // Not carried over from `unk58`, and the builds panel hides a zero.
        assert_eq!(stats.critical_rate, 0.0);
    }

    #[test]
    fn pre_rename_protocol_record_stats_still_loads() {
        let blob = cbor4ii::serde::to_vec(Vec::new(), &old_protocol_stats()).expect("serialize");

        let stats: protocol::RecordStats = cbor4ii::serde::from_slice(&blob).expect("deserialize");

        assert_eq!(stats.level, 10);
        assert_eq!(stats.power, 9999);
        assert_eq!(stats.critical_rate, 0.0);
    }

    /// A whole stored encounter through the real entry point, not just the leaf
    /// struct: zstd framing, `Encounter`'s own field names, and the block nested
    /// behind `Option<RecordStats>`. Covers the player-data path only — the
    /// protocol copy inside `raw_event_log` is pinned by the leaf test above.
    #[test]
    fn pre_rename_encounter_blob_still_loads() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct OldPlayerData {
            actor_index: u32,
            display_name: String,
            character_name: String,
            character_type: super::CharacterType,
            sigils: Vec<()>,
            stats: OldParserRecordStats,
            is_online: bool,
            weapon_info: Option<()>,
            overmastery_info: Option<()>,
            player_stats: Option<()>,
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct OldEncounter {
            player_data: [Option<OldPlayerData>; 4],
            quest_id: Option<u32>,
            quest_timer: Option<u32>,
            event_log: Vec<()>,
        }

        let old = OldEncounter {
            player_data: [
                Some(OldPlayerData {
                    actor_index: 0,
                    display_name: "Scott".to_string(),
                    character_name: "Scott".to_string(),
                    character_type: super::CharacterType::Unknown(0),
                    sigils: Vec::new(),
                    stats: old_parser_stats(),
                    is_online: false,
                    weapon_info: None,
                    overmastery_info: None,
                    player_stats: None,
                }),
                None,
                None,
                None,
            ],
            quest_id: None,
            quest_timer: None,
            event_log: Vec::new(),
        };

        let blob = super::to_stored_blob(&old).expect("encode stored blob");

        let parser = super::Parser::from_encounter_blob(&blob).expect("load stored encounter");

        let player = parser.encounter.player_data[0]
            .as_ref()
            .expect("player present");
        assert_eq!(player.display_name, "Scott");
        assert_eq!(player.stats.as_ref().expect("stats present").level, 10);
    }

    /// `DamageEvent` as written before `base_damage` (2026-07-17) and the two
    /// target-HP fields (2026-07-20) were added.
    ///
    /// These three carry no `#[serde(default)]`, and they do not need one: they
    /// are `Option`, and serde's missing-field path tries `deserialize_option`
    /// first, so an absent key reads back as `None`. That is the whole reason
    /// `critical_rate` broke and these did not — it is a plain `f32`. The tests
    /// below pin that distinction, because it is the thing that decides whether
    /// a new field needs an attribute.
    #[derive(Serialize)]
    struct OldDamageEvent {
        source: protocol::Actor,
        target: protocol::Actor,
        damage: i32,
        flags: u64,
        action_id: protocol::ActionType,
        attack_rate: Option<f32>,
        stun_value: Option<f32>,
        damage_cap: Option<i32>,
    }

    /// Externally-tagged like `protocol::Message`, so this writes the same
    /// `{"DamageEvent": {...}}` shape the real enum does.
    #[derive(Serialize)]
    enum OldMessage {
        DamageEvent(OldDamageEvent),
    }

    fn old_damage_event() -> OldDamageEvent {
        let actor = protocol::Actor {
            index: 0,
            actor_type: 0x2AF6_78E8,
            parent_actor_type: 0x2AF6_78E8,
            parent_index: 0,
        };
        OldDamageEvent {
            source: actor.clone(),
            target: actor,
            damage: 500,
            flags: 0,
            action_id: protocol::ActionType::Normal(1),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
        }
    }

    #[test]
    fn absent_option_fields_read_back_as_none() {
        let blob = cbor4ii::serde::to_vec(Vec::new(), &old_damage_event()).expect("serialize");

        let event: protocol::DamageEvent = cbor4ii::serde::from_slice(&blob).expect("deserialize");

        assert_eq!(event.damage, 500);
        assert_eq!(event.base_damage, None);
        assert_eq!(event.target_current_hp, None);
        assert_eq!(event.target_max_hp, None);
    }

    /// The same, through the real entry point and via BOTH routes a stored
    /// damage event can arrive by: the deprecated `event_log` and today's
    /// `raw_event_log`.
    #[test]
    fn pre_hp_fields_encounter_blob_still_loads() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct OldEventEncounter {
            player_data: [Option<()>; 4],
            quest_id: Option<u32>,
            quest_timer: Option<u32>,
            event_log: Vec<(i64, OldDamageEvent)>,
            raw_event_log: Vec<(i64, OldMessage)>,
        }

        let blob = super::to_stored_blob(&OldEventEncounter {
            player_data: [None, None, None, None],
            quest_id: None,
            quest_timer: None,
            event_log: vec![(1, old_damage_event())],
            raw_event_log: vec![(2, OldMessage::DamageEvent(old_damage_event()))],
        })
        .expect("encode stored blob");

        let parser = super::Parser::from_encounter_blob(&blob).expect("load stored encounter");

        assert_eq!(parser.encounter.event_log.len(), 1);
        assert_eq!(parser.encounter.raw_event_log.len(), 1);
    }
}

/// The `PlayerData` -> `LegalityInputs` bridge, tested with data in it.
///
/// `legality_inputs` lives here because `PlayerData`'s fields are private to
/// this module, and it is exercised nowhere else — `audit_player` has no
/// production caller yet. A bridge test built on `PlayerData::default()`
/// asserts nothing about the bridge: every rule is silent on empty input BY
/// DESIGN, so replacing any field's conversion with an empty value leaves such
/// a test green while the rule it feeds stops working in production forever.
///
/// So this fixture populates every field the bridge carries and pins the exact
/// set of rules that comes back. Dropping ANY single field — `skillboard` to
/// `Vec::new()`, `weapon_state`/`overmastery_info` to `None`, `sigils` or
/// `summons` to empty, `character_type` to something unrecognised — removes
/// its rule from that set and fails the assertion.
#[cfg(test)]
mod legality_bridge_tests {
    use super::*;
    use crate::legality::{audit_player, Rule};

    /// War Elemental's sigil id, whose intrinsic first trait is `4c588c27`.
    const WAR_ELEMENTAL_SIGIL: u32 = 0x0061_2b10;
    const WAR_ELEMENTAL_TRAIT: u32 = 0x4c58_8c27;
    const STEADY_FOCUS: u32 = 0x0053_599e;
    /// A real trait, used where an out-of-place one is needed.
    const DMG_CAP: u32 = 0xdc58_4f60;
    /// The Fortification family's primary trait (a legal wrightstone primary).
    const HP_TRAIT: u32 = 0xf372_f096;
    const SUPPLEMENTARY_DMG: u32 = 0x57ab_5b10;
    /// Wheel of Fate III — DMG Cap is not a candidate of any of its lots.
    const WHEEL_OF_FATE_III: u32 = 0x47e2_ae71;
    const CRIT_RATE_UP: u32 = 0x00d1_71e0;
    /// Overmastery ids: Attack, Health, Critical Hit Rate, Stun Power.
    const OM_ATTACK: u32 = 0xc492_5bd7;
    const OM_HEALTH: u32 = 0x52a2_07b5;
    const OM_CRIT: u32 = 0x45c6_5767;
    const OM_STUN: u32 = 0x6cb3_8ef3;

    fn populated_player() -> PlayerData {
        PlayerData {
            character_type: CharacterType::Pl0000,
            // SigilTraitLevel: two traits present, first at 30 over the
            // ceiling of 15.
            sigils: vec![Sigil {
                first_trait_id: WAR_ELEMENTAL_TRAIT,
                first_trait_level: 30,
                second_trait_id: STEADY_FOCUS,
                second_trait_level: 10,
                sigil_id: WAR_ELEMENTAL_SIGIL,
                equipped_character: 0,
                sigil_level: 15,
                acquisition_count: 1,
                notification_enum: 0,
            }],
            // SummonTrait: DMG Cap is not a candidate of the Wheel's main lot.
            summons: vec![EquippedSummon {
                summon_id: WHEEL_OF_FATE_III,
                main_trait_id: DMG_CAP,
                main_trait_level: 15,
                bonus_id: CRIT_RATE_UP,
                bonus_level: 9,
            }],
            // Rule 1: the primary slot's ceiling is 20.
            weapon_state: Some(WeaponState {
                weapon_id: 0,
                exp: 0,
                star_level: 0,
                plus_marks: 0,
                awakening_level: 0,
                wrightstone_id: 0,
                wrightstone_traits: vec![
                    WeaponTraitPair {
                        id: HP_TRAIT,
                        level: 25,
                    },
                    WeaponTraitPair {
                        id: DMG_CAP,
                        level: 15,
                    },
                    WeaponTraitPair {
                        id: SUPPLEMENTARY_DMG,
                        level: 10,
                    },
                ],
                innate_traits: Vec::new(),
            }),
            // Rule 8: 5000 is on no ladder. The other three are legal, and a
            // full set of four is required for the rule to speak at all.
            overmastery_info: Some(OvermasteryInfo {
                overmasteries: vec![
                    Overmastery {
                        id: OM_ATTACK,
                        flags: 0,
                        value: 5000.0,
                    },
                    Overmastery {
                        id: OM_HEALTH,
                        flags: 0,
                        value: 800.0,
                    },
                    Overmastery {
                        id: OM_CRIT,
                        flags: 0,
                        value: 6.0,
                    },
                    Overmastery {
                        id: OM_STUN,
                        flags: 0,
                        value: 0.6,
                    },
                ],
            }),
            // MasterTraitCount: one node past the 50-slot storage.
            skillboard: (0..=50).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_bridge_carries_every_field_the_rules_read() {
        let findings = audit_player(&populated_player());
        let rules: Vec<Rule> = findings.iter().map(|finding| finding.rule).collect();

        // One rule per bridged field, in `audit`'s own order. If this vector
        // shrinks, a field stopped crossing the bridge.
        assert_eq!(
            rules,
            vec![
                Rule::WrightstoneTraitLevel, // weapon_state
                Rule::SigilTraitLevel,       // sigils
                Rule::OvermasteryValue,      // overmastery_info
                Rule::SummonTrait,           // summons
                Rule::MasterTraitCount,      // skillboard
            ],
            "a field stopped crossing the PlayerData -> LegalityInputs bridge"
        );
    }

    /// The companion to the above: the same rules really are silent on empty
    /// input, which is exactly why the populated fixture is necessary.
    #[test]
    fn an_empty_player_is_silent_so_only_populated_input_tests_the_bridge() {
        assert_eq!(audit_player(&PlayerData::default()), vec![]);
    }
}
