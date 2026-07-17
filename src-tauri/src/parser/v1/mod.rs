use std::{collections::HashMap, io::BufReader};

use anyhow::Result;
use chrono::Utc;
use protocol::{
    AreaEnterEvent, ConfluxBuffAcquiredEvent, ConfluxRoomEnterEvent, ConfluxRunEndEvent,
    DamageEvent, Message, OnAttemptSBAEvent, OnContinueSBAChainEvent, OnDeathEvent,
    OnPerformSBAEvent, OnUpdateSBAEvent, PlayerIdentityEvent, PlayerLoadEvent, QuestCompleteEvent,
};

use crate::db::runs::{finalize_run, insert_run, ConfluxBuffDelta};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

use super::{
    constants::{CharacterType, EnemyType},
    v0,
};

mod cap_detection;
mod player_state;
mod skill_state;

use player_state::PlayerState;

pub struct AdjustedDamageInstance<'a> {
    pub event: &'a DamageEvent,
    pub player_data: Option<&'a PlayerData>,
    pub stun_damage: f64,
    pub is_capped: bool,
    /// Whether this hit is subject to a damage cap at all. Cap-less sources
    /// (supplementary damage, DoT, hits with no cap info) must count toward
    /// neither the capped-hit tallies nor their denominators.
    pub is_cappable: bool,
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
        let is_capped = is_cappable && cap_detection::is_capped(event.base_damage, event.damage_cap);

        Self {
            event,
            player_data,
            stun_damage,
            is_capped,
            is_cappable,
        }
    }
}

/// Equippable sigil for a character
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Serialize, Deserialize, Debug, Clone)]
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

#[derive(Serialize, Deserialize, Debug, Clone)]
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

#[derive(Serialize, Deserialize, Debug, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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

/// Data for a player in the encounter
#[derive(Debug, Serialize, Deserialize, Clone)]
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
    /// Whether this player was an online player or not
    is_online: bool,
    /// Weapon info for this player
    weapon_info: Option<WeaponInfo>,
    /// Overmastery info for this player
    overmastery_info: Option<OvermasteryInfo>,
    /// Player stats for this player
    player_stats: Option<PlayerStats>,
}

/// Derived breakdown for an enemy target
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnemyState {
    index: u32,
    target_type: EnemyType,
    raw_target_type: u32,
    total_damage: u64,
}

impl EnemyState {
    fn update_from_damage_event(&mut self, damage_instance: &AdjustedDamageInstance) {
        self.total_damage += damage_instance.event.damage as u64;
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

impl Encounter {
    /// Compresses this encounter data into a binary blob.
    pub fn to_blob(&self) -> Result<Vec<u8>> {
        let blob = cbor4ii::serde::to_vec(Vec::new(), &self)?;
        let mut reader = BufReader::new(blob.as_slice());
        let compressed_blob = zstd::encode_all(&mut reader, 3)?;
        Ok(compressed_blob)
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
}

/// The status of the parser.
#[derive(Debug, Serialize, Deserialize, Default, PartialEq, PartialOrd, Clone, Copy)]
enum ParserStatus {
    #[default]
    Waiting,
    InProgress,
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
    /// The total damage done in the encounter
    total_damage: u64,
    /// The total DPS done in the encounter
    dps: f64,
    /// The total stun value done in the encounter
    total_stun_value: f64,
    /// The total stun value per second done in the encounter
    stun_per_second: f64,
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
            total_damage: 0,
            dps: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            status: ParserStatus::Waiting,
            party: HashMap::new(),
            targets: HashMap::new(),
        }
    }
}

impl DerivedEncounterState {
    pub fn duration(&self) -> i64 {
        (self.end_time - self.start_time).max(1)
    }

    fn utc_start_time(&self) -> Result<chrono::DateTime<Utc>> {
        chrono::DateTime::from_timestamp_millis(self.start_time)
            .ok_or(anyhow::anyhow!("Failed to convert start time to DateTime"))
    }

    fn start(&mut self, now: i64) {
        self.start_time = now;
        self.end_time = now;
    }

    /// Gets the primary target of the encounter (the target that had the most damage done to it)
    fn get_primary_target(&self) -> Option<&EnemyState> {
        self.targets
            .values()
            .max_by_key(|target| target.total_damage)
    }

    fn process_damage_event(&mut self, now: i64, damage_instance: &AdjustedDamageInstance) {
        self.end_time = now;
        self.total_damage += damage_instance.event.damage as u64;
        self.dps = self.total_damage as f64 / ((self.duration()) as f64 / 1000.0);

        // Update stun value
        self.total_stun_value += damage_instance.stun_damage;
        self.stun_per_second = self.total_stun_value / ((self.duration()) as f64 / 1000.0);

        // Add actor to party if not already present.
        let source_player = self
            .party
            .entry(damage_instance.event.source.parent_index)
            .or_insert(PlayerState {
                index: damage_instance.event.source.parent_index,
                character_type: CharacterType::from_hash(
                    damage_instance.event.source.parent_actor_type,
                ),
                total_damage: 0,
                dps: 0.0,
                sba: 0.0,
                stun_per_second: 0.0,
                total_stun_value: 0.0,
                skill_breakdown: Vec::new(),
                last_known_pet_skill: None,
                capped_hits: 0,
                cappable_hits: 0,
                overcap_base_sum: 0.0,
                overcap_cap_sum: 0.0,
            });

        // Update player stats from damage event.
        source_player.update_from_damage_event(damage_instance);

        // Update target stats from damage event.
        let target = self
            .targets
            .entry(damage_instance.event.target.parent_index)
            .or_insert(EnemyState {
                index: damage_instance.event.target.parent_index,
                target_type: EnemyType::from_hash(damage_instance.event.target.parent_actor_type),
                raw_target_type: damage_instance.event.target.parent_actor_type,
                total_damage: 0,
            });

        target.update_from_damage_event(damage_instance);

        // Update everyone's DPS
        for player in self.party.values_mut() {
            player.update_dps(now, self.start_time);
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
fn remap_dragon_form(player_data: &[Option<PlayerData>; 4], event: &DamageEvent) -> DamageEvent {
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

/// The parser for the encounter.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Parser {
    /// Encounter that will be saved into the database, contains all the state needed to reparse
    pub encounter: Encounter,
    /// Derived state of the encounter, used for parsing the encounter into a calculated format that can be consumed by the front-end
    pub derived_state: DerivedEncounterState,
    /// Status of the parser
    status: ParserStatus,

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
        self.derived_state = Default::default();
        self.derived_state.start(self.start_time());

        for (timestamp, event) in self.encounter.event_log() {
            self.derived_state.end_time = *timestamp;

            if let Message::DamageEvent(event) = event {
                let event = remap_dragon_form(&self.encounter.player_data, event);

                let player_data = self
                    .encounter
                    .player_data
                    .iter()
                    .flatten()
                    .find(|player| player.actor_index == event.source.parent_index);

                let damage_instance =
                    AdjustedDamageInstance::from_damage_event(&event, player_data);

                self.derived_state
                    .process_damage_event(*timestamp, &damage_instance);
            }
        }
    }

    // Re-analyzes the encounter with the given targets.
    pub fn reparse_with_options(&mut self, targets: &[EnemyType]) {
        self.derived_state = Default::default();
        self.derived_state.start(self.start_time());

        for (timestamp, event) in self.encounter.event_log() {
            self.derived_state.end_time = *timestamp;

            if let Message::DamageEvent(event) = event {
                // If the target list is empty, then we're not filtering by target.
                // Otherwise, we only process damage events that match the target list.
                let target_type = EnemyType::from_hash(event.target.parent_actor_type);

                if targets.is_empty() || targets.contains(&target_type) {
                    let event = remap_dragon_form(&self.encounter.player_data, event);

                    let player_data = self
                        .encounter
                        .player_data
                        .iter()
                        .flatten()
                        .find(|player| player.actor_index == event.source.parent_index);

                    let damage_instance =
                        AdjustedDamageInstance::from_damage_event(&event, player_data);

                    self.derived_state
                        .process_damage_event(*timestamp, &damage_instance);
                }
            }
        }
    }

    pub fn generate_sba_chart(&self, interval: i64) -> HashMap<u32, Vec<f32>> {
        let start_time = self.start_time();
        let duration = self.derived_state.duration();

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

            if self.has_damage() {
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
        } else {
            self.update_status(ParserStatus::Waiting);
        }

        // Fresh encounter: stamp the incoming quest (0 = guarded read failed, keep it
        // unknown rather than storing a bogus id). quest_timer is only ever written by
        // the completion path — clear it so a later failed quest can't inherit it.
        self.encounter.quest_id =
            (event.last_known_quest_id != 0).then_some(event.last_known_quest_id);
        self.encounter.quest_timer = None;
        self.encounter.quest_completed = false;
        self.encounter.reset_player_data();

        if let Some(window) = &self.window_handle {
            let _ = window.emit("on-area-enter", &self.derived_state);
        }
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
            self.encounter.quest_timer = Some(event.elapsed_time_in_secs);
        }
        self.encounter.quest_completed = true;

        if self.status == ParserStatus::InProgress {
            self.update_status(ParserStatus::Stopped);

            if self.has_damage() {
                match self.save_encounter_to_db() {
                    Ok(id) => {
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

            if let Some(window) = &self.window_handle {
                let _ = window.emit("encounter-update", &self.derived_state);
            }
        }

        // v2.0.2: the area-enter hook (the old between-quest wipe point) no longer
        // installs, so the quest boundary is where stale identities must die — actor
        // indices get reused across quests, and entries carried over would attach the
        // previous quest's names to the next quest's actors. Cleared AFTER the save
        // above (the save reads player_data for the p1..p4 columns); every player's
        // identity is re-announced with their damage, so the next quest repopulates.
        self.encounter.reset_player_data();
    }

    // Called when a damage event is received from the game.
    pub fn on_damage_event(&mut self, event: DamageEvent) {
        let now = Utc::now().timestamp_millis();

        if Self::should_ignore_damage_event(&event) {
            return;
        }

        // If this is the first damage event, set the start time.
        if self.status == ParserStatus::Stopped || self.status == ParserStatus::Waiting {
            self.reset();
            self.derived_state.start(now);
            self.update_status(ParserStatus::InProgress);
        }

        self.encounter
            .push_event(now, Message::DamageEvent(event.clone()));

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

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
    }

    pub fn on_player_load_event(&mut self, event: PlayerLoadEvent) {
        let character_type = CharacterType::from_hash(event.character_type);

        // Ignore Id's transformation.
        if character_type == CharacterType::Pl2000 {
            return;
        }

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

        // Ignore Id's transformation (same guard as the full player_load path).
        if character_type == CharacterType::Pl2000 {
            return;
        }

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
        *slot = Some(player_data);

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-party-update", &self.encounter.player_data);
        }
    }

    /// Handles setting the SBA gauge value for a player
    pub fn on_sba_update(&mut self, event: OnUpdateSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnUpdateSBA(event.clone()),
        );

        let player_index = event.actor_index;
        if let Some(player) = self.derived_state.party.get_mut(&player_index) {
            player.set_sba(event.sba_value as f64);
        }

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
    }

    pub fn on_sba_attempt(&mut self, event: OnAttemptSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnAttemptSBA(event.clone()),
        );

        let player_index = event.actor_index;
        if let Some(player) = self.derived_state.party.get_mut(&player_index) {
            player.set_sba(800.0);
        }

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
    }

    pub fn on_sba_perform(&mut self, event: OnPerformSBAEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnPerformSBA(event.clone()),
        );

        let player_index = event.actor_index;
        if let Some(player) = self.derived_state.party.get_mut(&player_index) {
            player.set_sba(0.0);
        }

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
    }

    /// @TODO(false): Note that this event only fires for the local player.
    pub fn on_continue_sba_chain(&mut self, event: OnContinueSBAChainEvent) {
        self.encounter.push_event(
            Utc::now().timestamp_millis(),
            Message::OnContinueSBAChain(event.clone()),
        );

        let player_index = event.actor_index;
        if let Some(player) = self.derived_state.party.get_mut(&player_index) {
            player.set_sba(0.0);
        }

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
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
        self.update_status(ParserStatus::Waiting);

        if let Some(window) = &self.window_handle {
            let _ = window.emit("encounter-update", &self.derived_state);
        }
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

    // Checks if the damage event should be ignored for the purposes of parsing.
    fn should_ignore_damage_event(event: &DamageEvent) -> bool {
        let character_type = CharacterType::from_hash(event.source.parent_actor_type);

        if event.damage <= 0 {
            return true;
        }

        // Eugen's Grenade should be ignored.
        if event.target.actor_type == 0x022a350f {
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
            if self.has_damage() {
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
        let is_new_run = self.active_run_id.is_none() || self.active_run_manager != event.manager_ptr;

        if is_new_run {
            // A leftover NORMAL encounter can still be in progress here: a quest that
            // ended with no result screen (fail/retire) followed straight by a Conflux
            // run. The hook's quest-load boundary cut is deliberately suppressed on
            // room loads (it would finalize the run every room), so save the leftover
            // as a normal log now — otherwise its damage merges into room 1.
            if self.active_run_id.is_none() && self.status == ParserStatus::InProgress {
                self.update_status(ParserStatus::Stopped);
                if self.has_damage() {
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
            }

            // Close out any prior run before opening the new one (defensive: normally the
            // manager dtor already finalized it). Superseded by a new run → not "completed".
            if self.active_run_id.is_some() {
                self.finalize_active_run(false);
            }
            self.start_conflux_run(event.manager_ptr);
        } else {
            // Same run, next room: save the room we were just recording and advance.
            if self.status == ParserStatus::InProgress {
                self.update_status(ParserStatus::Stopped);
                if self.has_damage() {
                    let saved = self.save_room_to_db();
                    self.active_room_index += 1;
                    // Refresh an open Conflux tab so the room shows up mid-run, not
                    // only at run end.
                    if saved.is_ok() {
                        if let (Some(app), Some(run_id)) = (&self.app, self.active_run_id) {
                            let _ = app.emit_all("conflux-run-saved", run_id);
                        }
                    }
                }
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
                        total_damage
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
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
                    total_damage
                ],
            )?;

            let id = conn.last_insert_rowid();

            return Ok(Some(id));
        }

        Ok(None)
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
    use protocol::{ActionType, Actor};

    use super::*;

    fn parser_with_memory_db() -> Parser {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        let migrations = rusqlite_migration::Migrations::new(vec![
            rusqlite_migration::M::up("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, time INTEGER NOT NULL, duration INTEGER NOT NULL, data BLOB NOT NULL, version INTEGER NOT NULL DEFAULT 0, primary_target INTEGER, p1_name TEXT, p1_type TEXT, p2_name TEXT, p2_type TEXT, p3_name TEXT, p3_type TEXT, p4_name TEXT, p4_type TEXT, quest_id INTEGER, quest_elapsed_time INTEGER, quest_completed BOOLEAN, run_id INTEGER, room_index INTEGER, total_damage INTEGER)"),
            rusqlite_migration::M::up("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, duration INTEGER, room_count INTEGER NOT NULL DEFAULT 0, completed BOOLEAN, buffs TEXT)"),
        ]);
        migrations.to_latest(&mut conn).unwrap();
        Parser {
            db: Some(conn),
            ..Default::default()
        }
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
        }
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
        assert_eq!(timer, None, "failed quest must not inherit quest A's 213s timer");
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
        assert!(parser.active_run_id.is_none(), "run closed by leaving Conflux");

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
        assert_eq!(runs.len(), 1, "exactly ONE run for the whole 2-room sequence");
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

        parser.on_player_identity_event(identity_event("Alice", 0x8056ABCD, 2, 4_215_158_024, true));
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

    #[test]
    fn encounter_reset_clears_stale_player_data() {
        // v2.0.2: the area-enter hook is dead, so nothing wiped player_data between
        // quests — stale names attached to reused actor indices. The encounter reset
        // (first damage after Stopped/Waiting) must clear it; live identity events
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
        assert_eq!(player.cappable_hits, 110, "denominator counts all capped-capable hits");
        assert_eq!(player.capped_hits, 100, "only base>cap hits count as capped");
        let (skill_capped, skill_cappable) = player
            .skill_breakdown
            .iter()
            .fold((0, 0), |acc, s| (acc.0 + s.capped_hits, acc.1 + s.cappable_hits));
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
        assert_eq!(normal_logs, 1, "leftover normal encounter saved as its own log");
        assert_eq!(normal_damage, 500, "room damage not merged into it");
        let runs = crate::db::runs::get_runs(conn, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].rooms.len(), 1, "room 1 saved separately under the run");
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

        assert_eq!(parser.status, ParserStatus::Waiting);
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
