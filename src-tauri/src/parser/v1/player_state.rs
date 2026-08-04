use std::collections::HashMap;

use protocol::{ActionType, DamageEvent};
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, FerrySkillId};

use super::{skill_state::SkillState, AdjustedDamageInstance};

/// How long a Perfect Guard may claim a trailing network stun message. The
/// captured guard messages arrived at +100/+100/+101ms, and ordinary hits'
/// messages trail their own hit by ~30-70ms, so this is wide enough for the
/// guard's message and tight enough that the next attack's message is not
/// swallowed.
const GUARD_STUN_WINDOW_MS: i64 = 150;

/// The breakdown row a damage event belongs to: `(action, child character)`,
/// exactly the key [`PlayerState::breakdown_row_mut`] uses.
///
/// Stateful, and therefore order-dependent, for two reasons: Ferry's pet actions
/// are corrected from the last pet skill seen, and every supplementary-damage
/// hit folds into the FIRST supplementary row this player opened, whatever its
/// payload or body. Feed it one player's damage events in log order.
///
/// THE one place the row key is decided. [`PlayerState`] owns one of these and
/// routes every damage event through it, so the drill-down chart keying its
/// series the same way is not a second implementation that could drift — a chart
/// whose series did not correspond to breakdown rows would draw bands that no
/// row explains.
#[derive(Debug, Default)]
pub struct BreakdownKeying {
    last_known_pet_skill: Option<ActionType>,
    first_supplementary: Option<(ActionType, CharacterType)>,
    /// The row each RAW action id most recently resolved to, for events that
    /// carry an id but no row of their own — today only attributed SBA gains
    /// (see [`Self::row_for_raw_action`]).
    rows_by_raw_action: HashMap<ActionType, (ActionType, CharacterType)>,
}

impl BreakdownKeying {
    pub fn key_for(&mut self, event: &DamageEvent) -> (ActionType, CharacterType) {
        let key = self.resolve(event);
        // Remembered under the RAW id, which is what an SBA gain carries: the
        // resolved key can differ in BOTH halves (Ferry's pet remap rewrites the
        // action, a child actor changes the character), so a gain cannot
        // reconstruct it and has to be told.
        self.rows_by_raw_action.insert(event.action_id, key);
        key
    }

    /// The row a raw action id currently belongs to, or `None` if no damage
    /// event has opened one yet.
    ///
    /// LAST writer wins, deliberately: an id reused by two rows (Id's human and
    /// dragon forms share several) belongs to whichever form is swinging, and a
    /// gain arrives alongside the hit that caused it. The alternative — guessing
    /// from the id alone — is what produced the twin rows this replaced.
    pub fn row_for_raw_action(&self, action: ActionType) -> Option<(ActionType, CharacterType)> {
        self.rows_by_raw_action.get(&action).copied()
    }

    fn resolve(&mut self, event: &DamageEvent) -> (ActionType, CharacterType) {
        let parent_character_type = CharacterType::from_hash(event.source.parent_actor_type);
        let child_character_type = child_character_type_for(event);

        // Ferry's pet hits report the wrong action id, so hers are corrected.
        let action = if parent_character_type == CharacterType::Pl0700 {
            ferry_action(&mut self.last_known_pet_skill, event)
        } else {
            event.action_id
        };

        // Every echo shares one row regardless of payload or body, so the first
        // one seen names it — which is what collapses the whole family onto a
        // single breakdown row.
        if matches!(action, ActionType::SupplementaryDamage(_)) {
            return *self
                .first_supplementary
                .get_or_insert((action, child_character_type));
        }

        (action, child_character_type)
    }
}

/// The character a hit's breakdown row is filed under.
///
/// Seofon (Pl2200) collapses onto himself: his avatar's skill ids are his own.
pub(super) fn child_character_type_for(event: &DamageEvent) -> CharacterType {
    let parent_character_type = CharacterType::from_hash(event.source.parent_actor_type);
    // @TODO(false): Collapse all skill IDs from Seofon's avatar into his own.
    if parent_character_type == CharacterType::Pl2200 {
        parent_character_type
    } else {
        CharacterType::from_hash(event.source.actor_type)
    }
}

// @todo(false): maybe Ferry specific stuff can be removed/abstracted if some extra flags are found or the attribution is fixed
/// Ferry's pet hits report the wrong action id — strafe then dodge, and further
/// pet hits come back as "dodge" — so a pet skill is remembered and reused. The
/// remembered skill lives in [`BreakdownKeying`], which is the only caller.
fn ferry_action(last_known_pet_skill: &mut Option<ActionType>, event: &DamageEvent) -> ActionType {
    let is_ferry_pet =
        CharacterType::Pl0700Ghost == CharacterType::from_hash(event.source.actor_type);
    let is_ferry_pet_skill = is_ferry_pet && (event.flags & (1 << 2) != 0); // pet skills for ferry always have this flag set
    let is_ferry_pet_normal =
        is_ferry_pet && !is_ferry_pet_skill && event.action_id != ActionType::LinkAttack;

    // Umlauf excluded since that uses a separate actor which works correctly
    if is_ferry_pet_skill
        && [
            FerrySkillId::BlausGespenst,
            FerrySkillId::Pendel,
            FerrySkillId::Strafe,
        ]
        .into_iter()
        .any(|skill_id| ActionType::Normal(skill_id as u32) == event.action_id)
    {
        *last_known_pet_skill = Some(event.action_id);
    }

    const PET_NORMAL: ActionType = ActionType::Normal(FerrySkillId::PetNormal as u32);

    if is_ferry_pet_normal {
        // Note technically the pet portion of Onslaught will count as a Pet normal, but I think that's fine since
        // it does exactly as much as a pet normal. Could consider adding Onslaught (pet) as a separate category
        PET_NORMAL
    } else if is_ferry_pet_skill {
        match *last_known_pet_skill {
            None => PET_NORMAL, // May be good to instead have a separate "pet skill" backup for this case
            Some(skill_id) => skill_id,
        }
    } else {
        event.action_id
    }
}

/// A cause of gauge generation that is NOT one of the player's damaging hits.
///
/// Serialized as a plain string so `types.ts` can switch on it and map it to an
/// i18n key — the frontend never sees a raw RVA or tag number except through
/// [`SbaSourceState::id`].
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SbaSourceKind {
    DamageTaken,
    PerfectGuard,
    Effect,
    PartyAward,
    DirectorAward,
    QuestStart,
    PerfectDodge,
    Site,
    Unknown,
}

/// One cause's share of a player's generated gauge.
///
/// Deliberately NOT a `SkillState`: these have no hits and no damage, and every
/// damage/stun table reads `skill_breakdown`. Keeping them apart is what makes
/// "a gauge-only cause can never show up as a 0-hit damage row" structural
/// rather than a rule someone has to remember.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SbaSourceState {
    pub kind: SbaSourceKind,
    /// Effect-record key or site tag where the cause carries one.
    pub id: Option<u32>,
    pub generated: f64,
}

/// Derived stat breakdown for a player
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub index: u32,
    pub character_type: CharacterType,
    pub total_damage: u64,
    pub dps: f64,
    pub skill_breakdown: Vec<SkillState>,
    pub sba: f64,
    /// Total gauge this player GENERATED over the fight — the sum of every
    /// `OnUpdateSBAEvent::sba_added`.
    ///
    /// Distinct from `sba`, which is the gauge LEVEL and reads 0 right after a
    /// burst: a level answers "how full is it now", which ranks nobody. This is
    /// the contribution figure the SBA table sorts by.
    ///
    /// `#[serde(default)]` is defensive, matching the neighbouring stun fields:
    /// stored blobs carry only the raw `Encounter`, and derived state is
    /// rebuilt from it on every reparse, so nothing is ever deserialized into
    /// this field from disk.
    #[serde(default)]
    pub sba_generated: f64,
    /// Gauge generated by causes that are not the player's own damaging hits,
    /// one entry per (cause, id). Rebuilt on every reparse like the rest of the
    /// derived state; `#[serde(default)]` matches the neighbouring fields so a
    /// payload from an older binary still deserializes.
    #[serde(default)]
    pub sba_sources: Vec<SbaSourceState>,
    pub total_stun_value: f64,
    pub stun_per_second: f64,
    /// Stun measured as accumulator deltas across ProcessDamageEvent (the solo
    /// path; reads 0 online where stun is host-authoritative).
    #[serde(default)]
    pub stun_delta_sum: f64,
    /// Stun from the network stun-apply messages (`OnPlayerStun`; the online
    /// path — may also fire solo, where it duplicates the delta path).
    ///
    /// `total_stun_value` = max(delta, messages): the two paths observe the
    /// SAME accrual, so whichever captured it wins and double-counting is
    /// impossible in either mode.
    #[serde(default)]
    pub stun_message_sum: f64,
    /// Row key (action + child character) of this player's most recent
    /// stun-CAPABLE damage event — supplementary echoes and DoT ticks never
    /// proc stun and interleave between real hits, so they are skipped.
    /// Network stun messages (which carry no action id on the wire — receiver
    /// and dispatcher of game message type 7/subtype 8 read only
    /// {target, amount, source}) attribute to this row: messages trail their
    /// triggering hit by ~30-70ms, so the last real action is the trigger.
    #[serde(skip)]
    last_stun_attribution: Option<(ActionType, CharacterType)>,
    /// When this player's most recent Perfect Guard landed, while it is still
    /// unclaimed. A REMOTE player's guard stun is applied host-side and reaches
    /// us only as a network message trailing the guard — live capture 07-22: the
    /// three real remote guards were each followed at +100/+100/+101ms by a
    /// message carrying 188.4/188.4/125.6, against 12-71 for that slot's skill
    /// messages. Without this the guard's stun would attribute to whatever skill
    /// the player last hit with, leaving the guard row at 0.
    #[serde(skip)]
    last_guard_at: Option<i64>,
    /// Decides the breakdown row every damage event lands in. Stateful (Ferry's
    /// pet remap, the echo fold), so it must see this player's hits in log
    /// order — which is what feeding it from `update_from_damage_event` gives
    /// it. Not sent to the frontend and not stored: derived state is rebuilt by
    /// replaying the raw event log, which rebuilds this with it.
    #[serde(skip)]
    keying: BreakdownKeying,
    /// Attributed gauge gains whose causing action has no breakdown row yet,
    /// held by RAW action id until one opens (see [`Self::add_sba_gain`]).
    /// Anything still held when the fight ends is unattributed residue — the
    /// design's own posture, an unnamed gain over a confidently wrong one.
    /// Derive-time accumulator: rebuilt with the rest of the derived state on
    /// every reparse, so it is neither stored nor sent to the frontend.
    #[serde(skip)]
    pending_sba_gain: HashMap<ActionType, f64>,
    /// Number of hits by this player that reached the game's damage cap (base > cap)
    pub capped_hits: u32,
    /// Number of hits that were subject to a damage cap at all — the denominator
    /// for the cap percentage. Cap-less sources (supplementary damage, DoT) are
    /// excluded so they can't dilute the percentage.
    #[serde(default)]
    pub cappable_hits: u32,
    /// Sums over cappable hits that carried a pre-cap base, for the overcap %:
    /// `(overcap_base_sum / overcap_cap_sum) * 100` (the game's own display value).
    #[serde(default)]
    pub overcap_base_sum: f64,
    #[serde(default)]
    pub overcap_cap_sum: f64,
}

impl PlayerState {
    /// A zeroed row for a player who has produced no tracked events yet — the
    /// single place a fresh row is built, so a new field can never be
    /// initialized differently on different creation paths.
    pub fn new(index: u32, character_type: CharacterType) -> Self {
        PlayerState {
            index,
            character_type,
            total_damage: 0,
            dps: 0.0,
            sba: 0.0,
            sba_generated: 0.0,
            sba_sources: Vec::new(),
            stun_per_second: 0.0,
            total_stun_value: 0.0,
            stun_delta_sum: 0.0,
            stun_message_sum: 0.0,
            last_stun_attribution: None,
            last_guard_at: None,
            keying: BreakdownKeying::default(),
            pending_sba_gain: HashMap::new(),
            skill_breakdown: Vec::new(),
            capped_hits: 0,
            cappable_hits: 0,
            overcap_base_sum: 0.0,
            overcap_cap_sum: 0.0,
        }
    }

    /// Records one gauge reading. `added` is the increase this event carried —
    /// the game's own figure, not a difference we compute, so a burst resetting
    /// the gauge to 0 contributes nothing rather than a large negative.
    pub fn apply_sba(&mut self, sba: f64, added: f64) {
        self.sba = sba;
        self.sba_generated += added.max(0.0);
    }

    /// A gauge level with no generation attached — the attempt/perform/chain
    /// events, which force the gauge to a known value rather than adding to it.
    pub fn set_sba(&mut self, sba: f64) {
        self.sba = sba;
    }

    /// Folds one network stun message into this player's totals and attributes
    /// it to their most recent stun-capable skill row (the online per-skill
    /// stun source — the per-hit delta path is structurally 0 in lobbies). A
    /// message with no attribution yet (e.g. held pending before the player's
    /// first damage event) still counts toward the player total.
    pub fn add_stun_message(&mut self, timestamp: i64, amount: f64) {
        self.stun_message_sum += amount;
        self.refresh_total_stun();

        // A guard that just landed claims the message trailing it (see
        // `last_guard_at`); one message per guard, so the claim is consumed.
        // `saturating_sub`: a guard folded from the pending map carries `i64::MIN`
        // (no timing context), which would overflow a plain subtraction.
        let claims_guard = self.last_guard_at.is_some_and(|at| {
            at <= timestamp && timestamp.saturating_sub(at) <= GUARD_STUN_WINDOW_MS
        });
        let attribution = if claims_guard {
            self.last_guard_at = None;
            Some((ActionType::PerfectGuard, self.character_type))
        } else {
            self.last_stun_attribution
        };

        if let Some((action, child_character_type)) = attribution {
            self.breakdown_row_mut(action, child_character_type)
                .add_stun_message(amount);
        }
    }

    /// Files one attributed gauge gain against the breakdown row of the action
    /// that caused it.
    ///
    /// `action` is the RAW id the causing hit reported, so the row is looked up
    /// through [`BreakdownKeying::row_for_raw_action`] — the memo of what the
    /// damage path did with that same id. A gain NEVER opens a row: keying it
    /// itself is what produced the hit-less twin of every dragon-form skill in
    /// live log 1681 (the gain was filed under the player's own character while
    /// the hit belonged to its child actor's), and the same mis-key would hit
    /// Ferry, whose pet ids are remapped.
    ///
    /// A gain whose id has no row yet is HELD (see [`Self::pending_sba_gain`]),
    /// because the gain and its own damage event interleave arbitrarily on the
    /// wire.
    ///
    /// Deliberately does NOT touch `self.sba_generated`. The player total comes
    /// from the gauge poll, which covers all four party members; attribution
    /// covers only the local player. Adding here as well would double the local
    /// player's total while leaving everyone else's alone — this SPLITS the
    /// total, it does not contribute to it.
    pub fn add_sba_gain(&mut self, action: ActionType, amount: f64) {
        match self.keying.row_for_raw_action(action) {
            Some((row_action, child_character_type)) => {
                self.breakdown_row_mut(row_action, child_character_type)
                    .sba_generated += amount;
            }
            None => *self.pending_sba_gain.entry(action).or_default() += amount,
        }
    }

    /// Files one gauge gain that no skill row can hold (see [`SbaSourceState`]).
    ///
    /// Like [`Self::add_sba_gain`] this does NOT touch `sba_generated`: the
    /// player total comes from the four-slot poll, which already counted this
    /// rise. Causes split that total; they never add to it.
    pub fn add_sba_source(&mut self, kind: SbaSourceKind, id: Option<u32>, amount: f64) {
        match self
            .sba_sources
            .iter_mut()
            .find(|source| source.kind == kind && source.id == id)
        {
            Some(source) => source.generated += amount,
            None => self.sba_sources.push(SbaSourceState {
                kind,
                id,
                generated: amount,
            }),
        }
    }

    /// Folds one delta-path stun accrual that has no damage event of its own
    /// (Perfect Guard counters, non-guard stun procs) into this player: the
    /// delta-path total plus a zero-damage breakdown `action` row that counts the
    /// occurrences as hits and carries only their stun.
    fn add_synthesized_delta_stun(&mut self, action: ActionType, amount: f64) {
        self.stun_delta_sum += amount;
        self.refresh_total_stun();

        let row = self.breakdown_row_mut(action, self.character_type);
        row.hits += 1;
        row.add_stun_delta(amount);
    }

    /// Folds one Perfect Guard counter-stun into this player (see
    /// [`Self::add_synthesized_delta_stun`]) and arms the guard's claim on the
    /// stun message trailing it (see [`Self::last_guard_at`]), which is the only
    /// way a REMOTE player's guard stun can reach the guard's own row.
    pub fn add_perfect_guard_stun(&mut self, timestamp: i64, amount: f64) {
        self.last_guard_at = Some(timestamp);
        self.add_synthesized_delta_stun(ActionType::PerfectGuard, amount);
    }

    /// Folds one non-guard stun-application proc into this player. Live-confirmed
    /// 07-21 as Eugen's sticky grenade — real stun, but NOT a guard, so it gets
    /// its own [`ActionType::StunEffect`] row rather than inflating Perfect Guard.
    /// Index 0 is the only stun-effect proc we can attribute today; the index is
    /// reserved for a future discriminator (see `ActionType::StunEffect`).
    pub fn add_stun_effect(&mut self, amount: f64) {
        self.add_synthesized_delta_stun(ActionType::StunEffect(0), amount);
    }

    /// Counts one guarded Quickening (The World) as a hits-only breakdown row:
    /// no stun (the marker carries none) and no damage (the scripted counter
    /// damage is intentionally untracked).
    pub fn add_perfect_guard_quickening(&mut self) {
        self.breakdown_row_mut(ActionType::PerfectGuardQuickening, self.character_type)
            .hits += 1;
    }

    /// The find-or-create breakdown row for an `(action, child character type)`
    /// key — the same key [`Self::update_from_damage_event`] uses. Parser-
    /// synthesized rows (guards, stun-effect procs, which have no damage event)
    /// pass the player's own character type; online stun-message attribution
    /// passes the key of the damage event it points at, which virtually always
    /// already exists.
    fn breakdown_row_mut(
        &mut self,
        action: ActionType,
        child_character_type: CharacterType,
    ) -> &mut SkillState {
        if let Some(index) = self.skill_breakdown.iter().position(|skill| {
            skill.action_type == action && skill.child_character_type == child_character_type
        }) {
            return &mut self.skill_breakdown[index];
        }
        self.skill_breakdown
            .push(SkillState::new(action, child_character_type));
        self.skill_breakdown
            .last_mut()
            .expect("row pushed just above")
    }

    /// `total_stun_value` = whichever capture path saw the accrual (they
    /// measure the same accumulator, so max() dedupes them).
    fn refresh_total_stun(&mut self) {
        self.total_stun_value = self.stun_delta_sum.max(self.stun_message_sum);
    }

    /// Recomputes this player's rates against the encounter's duration, so a
    /// party row and the team total are always divided by the same clock.
    pub fn update_rates(&mut self, duration_secs: f64) {
        self.dps = self.total_damage as f64 / duration_secs;
        self.stun_per_second = self.total_stun_value / duration_secs;
    }

    pub fn update_from_damage_event(&mut self, damage_instance: &AdjustedDamageInstance) {
        if damage_instance.is_cappable {
            self.cappable_hits += 1;
        }
        if let Some((base, cap)) = damage_instance.overcap_contribution() {
            self.overcap_base_sum += base;
            self.overcap_cap_sum += cap;
        }
        if damage_instance.is_capped {
            self.capped_hits += 1;
        }
        self.total_damage += damage_instance.event.damage as u64;
        self.stun_delta_sum += damage_instance.stun_damage;
        self.refresh_total_stun();

        // Ferry's pet remap and the echo fold both live in `BreakdownKeying`,
        // so the row a hit lands in is decided in exactly one place — the same
        // place the drill-down chart asks, which is what makes a chart band and
        // a table row the same thing.
        //
        // NOTE: damage-over-time deliberately does NOT fold. Since the 2.0.2
        // hook fix its payload is the DoT TYPE (0 poison / 1 burn / 2 darkburn)
        // and each type is named separately in the breakdown, so one row per
        // type is what we want — ticks of the same type still merge on the key.
        let (action, child_character_type) = self.keying.key_for(damage_instance.event);

        // Remember where a trailing network stun message should attribute (see
        // the field doc): echoes and DoT ticks can't proc stun, so they must
        // not overwrite the real trigger between a hit and its stun message.
        if !matches!(
            action,
            ActionType::SupplementaryDamage(_) | ActionType::DamageOverTime(_)
        ) {
            self.last_stun_attribution = Some((action, child_character_type));
        }

        // A gain that beat its own damage event onto the wire has been waiting
        // for this row (see `add_sba_gain`); the raw id is the key it was held
        // under, and this is the moment it can be filed.
        let held = self
            .pending_sba_gain
            .remove(&damage_instance.event.action_id);

        let row = self.breakdown_row_mut(action, child_character_type);
        row.update_from_damage_event(damage_instance);
        if let Some(amount) = held {
            row.sba_generated += amount;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::parser::v1::{PlayerData, PlayerStats};

    use super::*;

    #[test]
    fn calculates_dps() {
        let mut player_state = empty_player();
        player_state.total_damage = 100;

        player_state.update_rates(1.0);

        assert_eq!(player_state.dps, 100.0);
    }

    /// The 2.0.2 DoT hook fix made the `DamageOverTime` payload the DoT TYPE
    /// (0 poison / 1 burn / 2 darkburn) instead of a constant 0, so each type earns its
    /// own named breakdown row. Ticks of the SAME type still aggregate into one row.
    #[test]
    fn damage_over_time_types_each_get_their_own_skill_row() {
        let mut player_state = empty_player();

        for (dot_type, damage) in [(0u32, 100), (1, 50), (2, 25), (0, 25)] {
            let event = plain_event(ActionType::DamageOverTime(dot_type), damage);
            player_state
                .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));
        }

        assert_eq!(
            player_state.skill_breakdown.len(),
            3,
            "poison/burn/darkburn are separate rows"
        );

        let poison = player_state
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::DamageOverTime(0))
            .expect("poison row");
        assert_eq!(poison.hits, 2, "same-type ticks aggregate");
        assert_eq!(poison.total_damage, 125);
    }

    #[test]
    fn updates_from_damage_event() {
        let mut player_state = empty_player();

        let damage_event = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));

        assert_eq!(player_state.total_damage, 100);
        assert_eq!(player_state.skill_breakdown.len(), 1);
        assert_eq!(player_state.skill_breakdown[0].total_damage, 100);
    }

    #[test]
    fn same_skill_updates_from_multiple_damage_events() {
        let mut player_state = empty_player();

        let damage_event = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));
        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));
        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));

        assert_eq!(player_state.total_damage, 300);
        assert_eq!(player_state.skill_breakdown.len(), 1);
        assert_eq!(player_state.skill_breakdown[0].total_damage, 300);
    }

    #[test]
    fn new_skills_are_tracked_separately() {
        let mut player_state = empty_player();

        let skill_one = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        let skill_two = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(2),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&skill_one, None));
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&skill_two, None));
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&skill_two, None));

        assert_eq!(player_state.total_damage, 300);
        assert_eq!(player_state.skill_breakdown.len(), 2);
        assert_eq!(player_state.skill_breakdown[0].total_damage, 100);
        assert_eq!(player_state.skill_breakdown[1].total_damage, 200);
    }

    #[test]
    fn skills_from_children_are_tracked_separately() {
        let mut player_state = empty_player();

        let parent_skill = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        let child_skill = DamageEvent {
            source: protocol::Actor {
                index: 1,
                actor_type: 1,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &parent_skill,
            None,
        ));
        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &child_skill,
            None,
        ));
        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &child_skill,
            None,
        ));

        assert_eq!(player_state.total_damage, 300);
        assert_eq!(player_state.skill_breakdown.len(), 2);
        assert_eq!(player_state.skill_breakdown[0].total_damage, 100);
        assert_eq!(player_state.skill_breakdown[1].total_damage, 200);
    }

    #[test]
    fn stun_is_tracked_with_player_stats() {
        let mut player_state = empty_player();

        let damage_event = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: Some(5.0),
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        let player_data = PlayerData {
            actor_index: 0,
            character_type: CharacterType::Pl0000,
            display_name: "Test".to_string(),
            character_name: "Test".to_string(),
            sigils: Vec::new(),
            summons: Vec::new(),
            abilities: Vec::new(),
            weapon_key: String::new(),
            master_level: 0,
            skillboard: Vec::new(),
            stats: None,
            weapon_state: None,
            is_online: false,
            weapon_info: None,
            overmastery_info: None,
            player_stats: Some(PlayerStats {
                level: 100,
                total_hp: 10000,
                total_attack: 1000,
                stun_power: 130.0,
                critical_rate: 100.0,
                total_power: 1000,
            }),
        };

        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            Some(&player_data),
        ));

        assert_eq!(player_state.total_stun_value, 5.0);
    }

    #[test]
    fn stun_value_without_player_stats() {
        let mut player_state = empty_player();

        let damage_event = DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: Some(5.0),
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        };

        player_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));

        assert_eq!(player_state.total_stun_value, 5.0);
    }

    fn capped_event() -> DamageEvent {
        DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(1),
            damage: 22_999,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: Some(22_999),
            base_damage: Some(40_000.0), // base > cap -> capped
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    fn uncapped_event() -> DamageEvent {
        DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id: ActionType::Normal(2),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: Some(22_999),
            base_damage: Some(100.0), // base < cap -> not capped
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    #[test]
    fn counts_player_capped_hits_across_skills() {
        let mut player_state = empty_player();

        // Two capped hits on the same skill (exercises the early-return path),
        // one uncapped hit on a different skill.
        let capped = capped_event();
        let uncapped = uncapped_event();
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&capped, None));
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&capped, None));
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&uncapped, None));

        assert_eq!(player_state.capped_hits, 2);
        // Skill-level counts are still correct through the early-return path.
        let normal_1 = player_state
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        assert_eq!(normal_1.capped_hits, 2);
    }

    fn empty_player() -> PlayerState {
        PlayerState::new(0, CharacterType::Pl0000)
    }

    /// A gauge-only cause is recorded as a SOURCE, never as a breakdown row: a
    /// row with no hits is what the damage and stun tables would then have to
    /// show (and did, for 38 rows, before the keying fix).
    #[test]
    fn a_non_skill_cause_never_opens_a_breakdown_row() {
        let mut player_state = empty_player();

        player_state.add_sba_source(SbaSourceKind::PartyAward, None, 35.0);
        player_state.add_sba_source(SbaSourceKind::DamageTaken, None, 7.0);

        assert!(player_state.skill_breakdown.is_empty());
        assert_eq!(player_state.sba_sources.len(), 2);
    }

    /// Every new cause kind must stay a SOURCE — pinned per-kind so adding one
    /// without routing it here fails a test, not a live fight.
    #[test]
    fn a_perfect_dodge_files_as_a_source() {
        let mut player_state = empty_player();
        player_state.add_sba_source(SbaSourceKind::PerfectDodge, None, 8.43);
        assert!(player_state.skill_breakdown.is_empty());
        assert_eq!(
            player_state.sba_sources[0].kind,
            SbaSourceKind::PerfectDodge
        );
    }

    /// Repeats of one cause aggregate, and an id discriminates two effects.
    #[test]
    fn sources_aggregate_per_cause_and_id() {
        let mut player_state = empty_player();

        player_state.add_sba_source(SbaSourceKind::PartyAward, None, 35.0);
        player_state.add_sba_source(SbaSourceKind::PartyAward, None, 35.0);
        player_state.add_sba_source(SbaSourceKind::Effect, Some(7), 3.0);
        player_state.add_sba_source(SbaSourceKind::Effect, Some(9), 4.0);

        let party = player_state
            .sba_sources
            .iter()
            .find(|source| source.kind == SbaSourceKind::PartyAward)
            .expect("party row");
        assert_eq!(party.generated, 70.0);
        assert_eq!(
            player_state
                .sba_sources
                .iter()
                .filter(|source| source.kind == SbaSourceKind::Effect)
                .count(),
            2,
            "two effect ids are two sources"
        );
    }

    /// The player TOTAL still comes from the gauge poll; a cause splits it.
    #[test]
    fn a_source_does_not_change_the_player_total() {
        let mut player_state = empty_player();
        player_state.apply_sba(500.0, 500.0);

        player_state.add_sba_source(SbaSourceKind::PartyAward, None, 35.0);

        assert_eq!(player_state.sba_generated, 500.0);
    }

    /// Id's dragon form: the hit comes from the Pl2000 child actor, so its
    /// breakdown row is filed under Pl2000 while the PLAYER is Pl1900.
    fn dragon_form_event(action_id: ActionType, damage: i32) -> DamageEvent {
        let mut event = plain_event(action_id, damage);
        event.source.actor_type = 0xF575_5C0E; // Pl2000
        event.source.parent_actor_type = 0x8056_ABCD; // Pl1900
        event
    }

    /// Regression (live log 1681, 2026-08-04): every dragon-form skill grew a
    /// twin row carrying gauge, no hits and no damage. The gain was keyed by the
    /// PLAYER's character type while the hit that caused it was keyed by the
    /// CHILD actor's, so `breakdown_row_mut`'s find-or-create invented a
    /// parallel row instead of finding the hit's own.
    #[test]
    fn sba_gain_lands_on_the_child_actor_row_that_earned_it() {
        let mut player_state = PlayerState::new(0, CharacterType::Pl1900);
        let event = dragon_form_event(ActionType::Normal(1100), 100);

        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));
        player_state.add_sba_gain(ActionType::Normal(1100), 12.5);

        assert_eq!(
            player_state.skill_breakdown.len(),
            1,
            "a gain files into the hit's row rather than opening a twin"
        );
        let row = &player_state.skill_breakdown[0];
        assert_eq!(row.child_character_type, CharacterType::Pl2000);
        assert_eq!(row.hits, 1);
        assert_eq!(row.sba_generated, 12.5);
    }

    /// Ferry's pet hits report the wrong action id and are remapped onto the
    /// remembered pet skill; a gain carries the RAW id, so it must follow the
    /// same remap rather than opening a row under the id nothing was filed to.
    #[test]
    fn sba_gain_follows_ferrys_pet_action_remap() {
        let mut player_state = PlayerState::new(0, CharacterType::Pl0700);
        let mut event = plain_event(ActionType::Normal(FerrySkillId::Strafe as u32), 100);
        event.source.actor_type = 0x2AF6_78E8; // Pl0700Ghost
        event.source.parent_actor_type = 0xFBA6_615D; // Pl0700 (Ferry)
        event.flags = 1 << 2; // pet skill
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));

        // A following pet hit reports "dodge" and is remapped back onto Strafe.
        let mut dodge = event.clone();
        dodge.action_id = ActionType::Normal(FerrySkillId::PetNormal as u32 + 1);
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&dodge, None));
        let rows_before = player_state.skill_breakdown.len();

        player_state.add_sba_gain(ActionType::Normal(FerrySkillId::PetNormal as u32 + 1), 7.0);

        assert_eq!(
            player_state.skill_breakdown.len(),
            rows_before,
            "the gain follows the remap instead of opening a row for the raw id"
        );
        let strafe = player_state
            .skill_breakdown
            .iter()
            .find(|row| row.action_type == ActionType::Normal(FerrySkillId::Strafe as u32))
            .expect("the remapped pet-skill row");
        assert_eq!(strafe.sba_generated, 7.0);
    }

    /// A gain and its own damage event interleave arbitrarily on the wire, so a
    /// gain that arrives first is held and lands when the hit opens its row —
    /// never as a row of its own.
    #[test]
    fn sba_gain_ahead_of_its_damage_event_is_held_until_the_row_exists() {
        let mut player_state = PlayerState::new(0, CharacterType::Pl1900);

        player_state.add_sba_gain(ActionType::Normal(1100), 12.5);
        assert!(
            player_state.skill_breakdown.is_empty(),
            "a held gain opens no row"
        );

        let event = dragon_form_event(ActionType::Normal(1100), 100);
        player_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));

        assert_eq!(player_state.skill_breakdown.len(), 1);
        let row = &player_state.skill_breakdown[0];
        assert_eq!(row.child_character_type, CharacterType::Pl2000);
        assert_eq!(row.sba_generated, 12.5, "the held gain lands on the row");
    }

    /// A gain for an action that never lands a hit stays unattributed rather
    /// than becoming a hit-less row — the residue the design already accepts.
    #[test]
    fn sba_gain_for_an_action_that_never_hits_opens_no_row() {
        let mut player_state = PlayerState::new(0, CharacterType::Pl1900);

        player_state.add_sba_gain(ActionType::Normal(1100), 12.5);

        assert!(player_state.skill_breakdown.is_empty());
    }

    fn plain_event(action_id: ActionType, damage: i32) -> DamageEvent {
        DamageEvent {
            source: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            target: protocol::Actor {
                index: 0,
                actor_type: 0,
                parent_actor_type: 0,
                parent_index: 0,
            },
            action_id,
            damage,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    /// The keys a standalone `BreakdownKeying` assigns to `events` — the way
    /// `build_ability_damage_chart` drives it — beside the rows `PlayerState`
    /// opens for the same events.
    ///
    /// `PlayerState` routes through a `BreakdownKeying` of its own, so this no
    /// longer guards two implementations against drift; it pins the property
    /// the drill-down chart is built on, that one key names exactly one row.
    /// The cases below are really about the folds themselves.
    fn keys_and_rows(
        events: &[DamageEvent],
    ) -> (
        Vec<(ActionType, CharacterType)>,
        Vec<(ActionType, CharacterType)>,
    ) {
        let mut keying = BreakdownKeying::default();
        let keys: Vec<_> = events.iter().map(|event| keying.key_for(event)).collect();

        let mut player = empty_player();
        for event in events {
            apply(&mut player, event);
        }
        let rows = player
            .skill_breakdown
            .iter()
            .map(|skill| (skill.action_type, skill.child_character_type))
            .collect();

        (keys, rows)
    }

    #[test]
    fn keying_agrees_with_the_rows_player_state_opens() {
        let events = [
            plain_event(ActionType::Normal(100), 10),
            plain_event(ActionType::Normal(200), 20),
            plain_event(ActionType::Normal(100), 30),
            plain_event(ActionType::LinkAttack, 40),
            plain_event(ActionType::DamageOverTime(0), 5),
            plain_event(ActionType::DamageOverTime(1), 5),
        ];

        let (keys, rows) = keys_and_rows(&events);

        let distinct: HashSet<_> = keys.iter().copied().collect();
        assert_eq!(
            distinct,
            rows.iter().copied().collect::<HashSet<_>>(),
            "every key must name a row, and every row must have a key"
        );
    }

    #[test]
    fn keying_folds_every_echo_onto_the_first_supplementary_row() {
        // The payload differs per trigger and every echo shares one row, so
        // three distinct payloads must still collapse to a single key — or the
        // chart draws one band per trigger against a single table row.
        let events = [
            plain_event(ActionType::SupplementaryDamage(1), 10),
            plain_event(ActionType::SupplementaryDamage(2), 20),
            plain_event(ActionType::SupplementaryDamage(3), 30),
        ];

        let (keys, rows) = keys_and_rows(&events);

        assert_eq!(rows.len(), 1, "one row for every echo");
        assert_eq!(
            keys.iter().copied().collect::<HashSet<_>>().len(),
            1,
            "one key for every echo"
        );
        assert_eq!(keys[0], rows[0]);
    }

    #[test]
    fn keying_files_seofons_avatar_under_seofon() {
        let mut event = plain_event(ActionType::Normal(100), 10);
        event.source.parent_actor_type = 0x59DB0CD9; // Pl2200
        event.source.actor_type = 0xDEADBEEF; // the avatar's own body

        let (keys, rows) = keys_and_rows(&[event]);

        assert_eq!(keys[0].1, CharacterType::Pl2200);
        assert_eq!(keys[0], rows[0]);
    }

    fn apply(player: &mut PlayerState, event: &DamageEvent) {
        player.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(event, None));
    }

    #[test]
    fn supplementary_events_merge_into_single_row() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        // Different trigger action ids, same merged row.
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 200),
        );
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(99), 800),
        );

        assert_eq!(player.skill_breakdown.len(), 2);
        let merged = player
            .skill_breakdown
            .iter()
            .find(|s| matches!(s.action_type, ActionType::SupplementaryDamage(_)))
            .unwrap();
        assert_eq!(merged.hits, 2);
        assert_eq!(merged.total_damage, 1000);
        assert_eq!(player.total_damage, 2000);
    }

    /// A non-guard stun-application proc (Eugen's sticky grenade) gets its OWN
    /// zero-damage row and must never inflate the Perfect Guard row; its stun
    /// still counts toward the player total and its eligible-hit count.
    #[test]
    fn stun_effect_gets_its_own_row_separate_from_perfect_guard() {
        let mut player = empty_player();
        player.add_stun_effect(25.0);
        player.add_stun_effect(25.0);
        player.add_perfect_guard_stun(0, 250.0);

        let effect = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::StunEffect(0))
            .expect("stun effect row");
        assert_eq!(effect.hits, 2);
        assert_eq!(effect.total_stun_value, 50.0);
        assert_eq!(effect.stun_eligible_hits, 2);

        let pg = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::PerfectGuard)
            .expect("perfect guard row");
        assert_eq!(pg.hits, 1);
        assert_eq!(pg.total_stun_value, 250.0);

        // Both paths feed the player's delta-path total.
        assert_eq!(player.total_stun_value, 300.0);
    }
}
