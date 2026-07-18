use protocol::ActionType;
use serde::{Deserialize, Serialize};

use crate::parser::constants::CharacterType;

use super::AdjustedDamageInstance;

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
    /// Number of hits that reached the game's damage cap for this skill (base > cap).
    pub capped_hits: u32,
    /// Number of hits that were subject to a damage cap at all — the denominator
    /// for the cap percentage (cap-less sources like supplementary damage excluded).
    #[serde(default)]
    pub cappable_hits: u32,
    /// Running sums over cappable hits that carried a pre-cap base, used to compute
    /// the game's overcap %: `(overcap_base_sum / overcap_cap_sum) * 100`. Kept as
    /// sums (not a precomputed %) so the frontend can aggregate across skills and
    /// choose the denominator. `f64` to avoid overflow on long fights.
    #[serde(default)]
    pub overcap_base_sum: f64,
    #[serde(default)]
    pub overcap_cap_sum: f64,
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
            overcap_base_sum: 0.0,
            overcap_cap_sum: 0.0,
        }
    }

    pub fn update_from_damage_event(&mut self, damage_instance: &AdjustedDamageInstance) {
        if damage_instance.is_cappable {
            self.cappable_hits += 1;
        }
        // Accumulate base/cap for the overcap % when the game gave us a pre-cap base.
        if let Some((base, cap)) = damage_instance.overcap_contribution() {
            self.overcap_base_sum += base;
            self.overcap_cap_sum += cap;
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
            base_damage: None,
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
            base_damage: None,
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

    fn make_event(damage: i32, damage_cap: Option<i32>, base_damage: Option<f32>) -> DamageEvent {
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
            base_damage,
        }
    }

    #[test]
    fn counts_capped_hits() {
        use crate::parser::v1::AdjustedDamageInstance;

        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        // base == cap -> NOT over the cap
        let e1 = make_event(22_999, Some(22_999), Some(22_999.0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e1, None));
        // base > cap -> capped
        let e2 = make_event(22_999, Some(22_999), Some(40_000.0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e2, None));
        // base < cap -> not capped
        let e3 = make_event(10_000, Some(22_999), Some(10_000.0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e3, None));
        // no cap info -> not capped (and not cappable)
        let e4 = make_event(99_999, None, Some(200_000.0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e4, None));
        // cap == 0 -> not capped (guard against bogus zero cap)
        let e5 = make_event(5_000, Some(0), Some(50_000.0));
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e5, None));
        // real cap but no base (old-style hit) -> cappable but never counted capped
        let e6 = make_event(30_000, Some(22_999), None);
        skill_state.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&e6, None));

        assert_eq!(skill_state.hits, 6);
        // only e2 has base > cap
        assert_eq!(skill_state.capped_hits, 1);
        // e1, e2, e3, e6 carried a real positive cap; e4 (none) and e5 (zero) did not.
        assert_eq!(skill_state.cappable_hits, 4);
        // overcap sums accumulate over cappable hits that carried a base: e1,e2,e3
        // (e6 had no base). base_sum = 22999+40000+10000, cap_sum = 22999*3.
        assert_eq!(skill_state.overcap_base_sum, 72_999.0);
        assert_eq!(skill_state.overcap_cap_sum, 68_997.0);
    }

    #[test]
    fn supplementary_damage_is_never_capped_nor_cappable() {
        use crate::parser::v1::AdjustedDamageInstance;

        let mut skill_state =
            SkillState::new(ActionType::SupplementaryDamage(1), CharacterType::Pl0000);

        // A supplementary event that recorded its trigger's cap (as old logs did):
        // a base over the cap must NOT count as capped, and the hit must not count
        // toward the cappable denominator either.
        let mut event = make_event(22_999, Some(22_999), Some(40_000.0));
        event.action_id = ActionType::SupplementaryDamage(1);

        skill_state
            .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));

        assert_eq!(skill_state.hits, 1);
        assert_eq!(skill_state.capped_hits, 0);
        assert_eq!(skill_state.cappable_hits, 0);
    }
}
