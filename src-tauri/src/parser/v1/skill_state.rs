use std::collections::VecDeque;

use protocol::ActionType;
use serde::{Deserialize, Serialize};

use crate::parser::constants::CharacterType;

use super::AdjustedDamageInstance;

/// Which proc mechanic produced a supplementary-type damage event.
/// The event stream carries no discriminator — flags are identical for both —
/// so classification divides the proc's damage by its trigger hit's damage:
/// Supplementary procs deal 0.2x, Echo procs 0.4x (spec 2026-07-16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcKind {
    Supplementary,
    Echo,
}

const SUPP_RATIO: f64 = 0.2;
const ECHO_RATIO: f64 = 0.4;
/// Geometric mean of 0.2 and 0.4 — the classification boundary.
const RATIO_MIDPOINT: f64 = 0.283;
/// A ratio this close to 0.2/0.4 is an exact match; nothing can beat it.
const EXACT_TOLERANCE: f64 = 0.002;
/// Window size measured on logs 244-247: accuracy plateaus at 8, larger
/// windows only add ambiguous 2x pairs.
const RECENT_HITS_WINDOW: usize = 8;

/// Derived stat breakdown of a particular skill
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillState {
    /// Type of action ID that this skill is
    pub action_type: ActionType,
    /// Child character this skill belongs to (pet, Id's dragonform, etc.)
    pub child_character_type: CharacterType,
    /// Number of hits this skill has done
    pub hits: u32,
    /// Minimum damage done by this skill
    pub min_damage: Option<u64>,
    /// Maximum damage done by this skill
    pub max_damage: Option<u64>,
    /// Total damage done by this skill
    pub total_damage: u64,
    /// Maximum stun value done by this skill
    pub max_stun_value: f64,
    /// Total stun value done by this skill
    pub total_stun_value: f64,
    /// Number of hits that reached the game's damage cap for this skill
    pub capped_hits: u32,
    /// Number of hits that were subject to a damage cap at all — the denominator
    /// for the cap percentage (cap-less sources like supplementary damage excluded).
    #[serde(default)]
    pub cappable_hits: u32,
    /// `(damage, cap)` of every cappable hit, kept so `capped_hits` can be
    /// recounted once the encounter's crit multipliers are learned mid-run
    /// (see `reclassify_caps`). Never serialized — it grows with hit count and
    /// the frontend only needs the counters.
    #[serde(skip)]
    pub cappable_samples: Vec<(i32, i32)>,
    /// Procs classified as Supplementary (≈0.2× their trigger hit)
    #[serde(default)]
    pub supp_hits: u32,
    /// Procs classified as Echo (≈0.4× their trigger hit)
    #[serde(default)]
    pub echo_hits: u32,
    /// Damage from Supplementary procs attributed to this skill
    #[serde(default)]
    pub supp_damage: u64,
    /// Damage from Echo procs attributed to this skill
    #[serde(default)]
    pub echo_damage: u64,
    /// `(damage, target_index, target_actor_type)` of the last 8 hits, used to
    /// classify proc events by ratio. Never serialized — rebuilt on re-parse.
    #[serde(skip)]
    pub recent_hits: VecDeque<(i32, u32, u32)>,
}

impl SkillState {
    pub fn new(action_type: ActionType, child_character_type: CharacterType) -> Self {
        Self {
            action_type,
            child_character_type,
            hits: 0,
            min_damage: None,
            max_damage: None,
            total_damage: 0,
            max_stun_value: 0.0,
            total_stun_value: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
            cappable_samples: Vec::new(),
            supp_hits: 0,
            echo_hits: 0,
            supp_damage: 0,
            echo_damage: 0,
            recent_hits: VecDeque::new(),
        }
    }

    pub fn update_from_damage_event(&mut self, damage_instance: &AdjustedDamageInstance) {
        if damage_instance.is_cappable {
            self.cappable_hits += 1;
            if let Some(cap) = damage_instance.event.damage_cap {
                self.cappable_samples.push((damage_instance.event.damage, cap));
            }
        }
        if damage_instance.is_capped {
            self.capped_hits += 1;
        }
        self.hits += 1;
        self.total_damage += damage_instance.event.damage as u64;
        self.max_stun_value = self.max_stun_value.max(damage_instance.stun_damage);
        self.total_stun_value += damage_instance.stun_damage;

        if let Some(min_damage) = self.min_damage {
            self.min_damage = Some(min_damage.min(damage_instance.event.damage as u64));
        } else {
            self.min_damage = Some(damage_instance.event.damage as u64);
        }

        if let Some(max_damage) = self.max_damage {
            self.max_damage = Some(max_damage.max(damage_instance.event.damage as u64));
        } else {
            self.max_damage = Some(damage_instance.event.damage as u64);
        }

        self.recent_hits.push_back((
            damage_instance.event.damage,
            damage_instance.event.target.index,
            damage_instance.event.target.actor_type,
        ));
        if self.recent_hits.len() > RECENT_HITS_WINDOW {
            self.recent_hits.pop_front();
        }
    }

    /// Classify a supplementary-type proc against this skill's recent hits.
    /// Search order (spec): exact ratio match on the proc's own target, then
    /// exact match on any target, then nearest ratio overall. Iteration is
    /// newest-first so ties break toward the most recent hit. An empty buffer
    /// defaults to Supplementary.
    pub fn classify_proc(
        &self,
        proc_damage: i32,
        target_index: u32,
        target_actor_type: u32,
    ) -> ProcKind {
        let dist = |r: f64| (r - SUPP_RATIO).abs().min((r - ECHO_RATIO).abs());
        let kind_of = |r: f64| {
            if r < RATIO_MIDPOINT {
                ProcKind::Supplementary
            } else {
                ProcKind::Echo
            }
        };
        let ratios = |same_target_only: bool| {
            self.recent_hits
                .iter()
                .rev()
                .filter(move |(damage, t_idx, t_type)| {
                    *damage > 0
                        && (!same_target_only
                            || (*t_idx == target_index && *t_type == target_actor_type))
                })
                .map(move |(damage, _, _)| proc_damage as f64 / *damage as f64)
        };

        if let Some(r) = ratios(true).find(|r| dist(*r) < EXACT_TOLERANCE) {
            return kind_of(r);
        }
        if let Some(r) = ratios(false).find(|r| dist(*r) < EXACT_TOLERANCE) {
            return kind_of(r);
        }
        // Nearest bucket. Strict `<` keeps the first (newest) of equal candidates.
        let mut best: Option<f64> = None;
        for r in ratios(false) {
            if best.map_or(true, |b| dist(r) < dist(b)) {
                best = Some(r);
            }
        }
        best.map(kind_of).unwrap_or(ProcKind::Supplementary)
    }

    /// Recount `capped_hits` against newly-learned crit multipliers (the live path
    /// classifies hits with the simple rule as they arrive; this converges the
    /// running counts to what a full crit-aware reparse would produce).
    pub fn reclassify_caps(&mut self, crit_multipliers: &[f64]) {
        self.capped_hits = self
            .cappable_samples
            .iter()
            .filter(|(damage, cap)| {
                super::cap_detection::is_capped(*damage, Some(*cap), crit_multipliers)
            })
            .count() as u32;
    }
}

#[cfg(test)]
mod tests {
    use protocol::{Actor, DamageEvent};

    use super::*;

    #[test]
    fn updating_from_damage_event() {
        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        let damage_event = DamageEvent {
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
            action_id: ActionType::Normal(1),
            damage: 100,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
        };

        let damage_event_two = DamageEvent {
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
            action_id: ActionType::Normal(1),
            damage: 1999,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
        };

        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event,
            None,
        ));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(
            &damage_event_two,
            None,
        ));

        assert_eq!(skill_state.hits, 2);
        assert_eq!(skill_state.min_damage, Some(100));
        assert_eq!(skill_state.max_damage, Some(1999));
        assert_eq!(skill_state.total_damage, 2099);
    }

    fn make_event(damage: i32, damage_cap: Option<i32>) -> DamageEvent {
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
            action_id: ActionType::Normal(1),
            damage,
            flags: 0,
            attack_rate: None,
            stun_value: None,
            damage_cap,
        }
    }

    #[test]
    fn counts_capped_hits() {
        use crate::parser::v1::AdjustedDamageInstance;

        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        // damage == cap -> capped
        let e1 = make_event(22_999, Some(22_999));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e1, None));
        // damage > cap -> capped
        let e2 = make_event(30_000, Some(22_999));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e2, None));
        // damage < cap -> not capped
        let e3 = make_event(10_000, Some(22_999));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e3, None));
        // no cap info -> not capped
        let e4 = make_event(99_999, None);
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e4, None));
        // cap == 0 -> not capped (guard against bogus zero cap)
        let e5 = make_event(5_000, Some(0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e5, None));

        assert_eq!(skill_state.hits, 5);
        assert_eq!(skill_state.capped_hits, 2);
        // e1..e3 carried a real cap; e4 (no cap info) and e5 (zero cap) did not.
        assert_eq!(skill_state.cappable_hits, 3);
    }

    #[test]
    fn supplementary_damage_is_never_capped_nor_cappable() {
        use crate::parser::v1::AdjustedDamageInstance;

        let mut skill_state =
            SkillState::new(ActionType::SupplementaryDamage(1), CharacterType::Pl0000);

        // A supplementary event that recorded its trigger's cap (as old logs did):
        // damage at the cap must NOT count as capped, and the hit must not count
        // toward the cappable denominator either.
        let mut event = make_event(22_999, Some(22_999));
        event.action_id = ActionType::SupplementaryDamage(1);

        skill_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));

        assert_eq!(skill_state.hits, 1);
        assert_eq!(skill_state.capped_hits, 0);
        assert_eq!(skill_state.cappable_hits, 0);
    }

    fn make_event_on_target(damage: i32, target_index: u32) -> DamageEvent {
        let mut event = make_event(damage, None);
        event.target.index = target_index;
        event
    }

    fn record_hit(skill: &mut SkillState, damage: i32, target_index: u32) {
        let event = make_event_on_target(damage, target_index);
        skill.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));
    }

    #[test]
    fn classifies_supplementary_ratio() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        assert_eq!(skill.classify_proc(200, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn classifies_echo_ratio() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        assert_eq!(skill.classify_proc(400, 0, 0), ProcKind::Echo);
    }

    #[test]
    fn picks_best_hit_across_window_not_newest() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        // Older hit is the true trigger (ratio 0.2); newest gives a garbage 0.5.
        record_hit(&mut skill, 1_000_000, 0);
        record_hit(&mut skill, 400_000, 0);
        assert_eq!(skill.classify_proc(200_000, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn empty_buffer_defaults_to_supplementary() {
        let skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        assert_eq!(skill.classify_proc(12345, 0, 0), ProcKind::Supplementary);
    }

    #[test]
    fn ambiguous_two_x_pair_prefers_same_target() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        // 2,000,000 on target 1 and 1,000,000 on target 2: a 400,000 proc is
        // exactly 0.2x the first AND 0.4x the second. Same-target must win.
        record_hit(&mut skill, 2_000_000, 1);
        record_hit(&mut skill, 1_000_000, 2);
        assert_eq!(skill.classify_proc(400_000, 2, 0), ProcKind::Echo);
        assert_eq!(skill.classify_proc(400_000, 1, 0), ProcKind::Supplementary);
    }

    #[test]
    fn nearest_bucket_when_no_exact_match() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        record_hit(&mut skill, 1000, 0);
        // 0.27 -> below the 0.283 midpoint -> Supplementary
        assert_eq!(skill.classify_proc(270, 0, 0), ProcKind::Supplementary);
        // 0.30 -> above the midpoint -> Echo
        assert_eq!(skill.classify_proc(300, 0, 0), ProcKind::Echo);
    }

    #[test]
    fn old_serialized_state_defaults_proc_fields_to_zero() {
        // Old logs' derived state lacks the proc fields; serde(default) must
        // fill zeros and the skip'd ring buffer must come back empty.
        let skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        let mut json: serde_json::Value = serde_json::to_value(&skill).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("suppHits");
        obj.remove("echoHits");
        obj.remove("suppDamage");
        obj.remove("echoDamage");
        let revived: SkillState = serde_json::from_value(json).unwrap();
        assert_eq!(revived.supp_hits, 0);
        assert_eq!(revived.echo_hits, 0);
        assert_eq!(revived.supp_damage, 0);
        assert_eq!(revived.echo_damage, 0);
        assert!(revived.recent_hits.is_empty());
    }

    #[test]
    fn ring_buffer_caps_at_window_size() {
        let mut skill = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);
        for i in 0..10 {
            record_hit(&mut skill, 1000 + i, 0);
        }
        assert_eq!(skill.recent_hits.len(), 8);
        // Oldest entries (1000, 1001) evicted.
        assert_eq!(skill.recent_hits.front().copied(), Some((1002, 0, 0)));
    }
}
