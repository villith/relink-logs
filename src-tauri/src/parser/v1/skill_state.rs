use protocol::ActionType;
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, EnemyType};

use super::AdjustedDamageInstance;

/// Damage attribution of one enemy type within a skill's stats — the
/// quest-details per-enemy tooltip breakdown. Accumulated during the same
/// reparse as everything else, so it reflects the active target/time filters.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetState {
    pub enemy_type: EnemyType,
    pub hits: u32,
    pub total_damage: u64,
}

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
    /// Stun via per-hit accumulator deltas (the solo path; structurally 0 in
    /// online lobbies where enemy stun is host-authoritative).
    #[serde(default)]
    pub stun_delta_sum: f64,
    /// Stun via network stun-apply messages attributed to this skill as the
    /// source player's most recent stun-capable action (the online path; may
    /// also fire solo, duplicating the delta path).
    ///
    /// `total_stun_value` = max(delta, messages): both paths observe the same
    /// accumulator, so whichever captured the accrual wins and double-counting
    /// is impossible in either mode.
    #[serde(default)]
    pub stun_message_sum: f64,
    /// Number of DELTA-path hits that actually applied stun (amount > 0) — the
    /// solo per-hit count. A stun-capable hit that dealt 0 stun (target
    /// stunned/immune) is excluded; supplementary/DoT hits carry no stun so they
    /// never count. Internal accumulator: only `stun_eligible_hits` (their max) is
    /// exposed, so this is skipped from the payload/stored blob rather than
    /// mirrored in `types.ts`.
    #[serde(skip)]
    pub stun_delta_hits: u32,
    /// Number of attributed network stun messages with a positive amount — the
    /// online count (per-hit deltas are 0 there). Internal accumulator, skipped
    /// like [`Self::stun_delta_hits`].
    #[serde(skip)]
    pub stun_message_hits: u32,
    /// Hits that actually applied stun: `max(stun_delta_hits, stun_message_hits)`.
    /// Mirrors `total_stun_value`'s max over the two paths, so solo-loopback
    /// (both paths fire) can't double-count. The denominator for "stun per hit".
    #[serde(default)]
    pub stun_eligible_hits: u32,
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
    /// Per-enemy-type share of this skill's damage (same-type spawns merge).
    #[serde(default)]
    pub targets: Vec<SkillTargetState>,
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
            stun_delta_sum: 0.0,
            stun_message_sum: 0.0,
            stun_delta_hits: 0,
            stun_message_hits: 0,
            stun_eligible_hits: 0,
            capped_hits: 0,
            cappable_hits: 0,
            overcap_base_sum: 0.0,
            overcap_cap_sum: 0.0,
            targets: Vec::new(),
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

        let enemy_type = EnemyType::from_hash(damage_instance.event.target.parent_actor_type);
        match self
            .targets
            .iter_mut()
            .find(|target| target.enemy_type == enemy_type)
        {
            Some(target) => {
                target.hits += 1;
                target.total_damage += damage_instance.event.damage as u64;
            }
            None => self.targets.push(SkillTargetState {
                enemy_type,
                hits: 1,
                total_damage: damage_instance.event.damage as u64,
            }),
        }
        self.add_stun_delta(damage_instance.stun_damage);

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

    /// Folds one DELTA-path stun accrual into this skill (per-hit accumulator
    /// delta, or a Perfect Guard capture — both measure the accumulator
    /// directly). A positive amount is one hit that actually applied stun.
    pub fn add_stun_delta(&mut self, amount: f64) {
        self.stun_delta_sum += amount;
        if amount > 0.0 {
            self.stun_delta_hits += 1;
        }
        self.max_stun_value = self.max_stun_value.max(amount);
        self.refresh_total_stun();
    }

    /// Folds one attributed network stun message into this skill. A positive
    /// amount is one stun application (the online analogue of a stunning hit).
    pub fn add_stun_message(&mut self, amount: f64) {
        self.stun_message_sum += amount;
        if amount > 0.0 {
            self.stun_message_hits += 1;
        }
        self.max_stun_value = self.max_stun_value.max(amount);
        self.refresh_total_stun();
    }

    /// `total_stun_value` / `stun_eligible_hits` = whichever capture path saw the
    /// accrual (the per-skill mirror of `PlayerState::refresh_total_stun`).
    fn refresh_total_stun(&mut self) {
        self.total_stun_value = self.stun_delta_sum.max(self.stun_message_sum);
        self.stun_eligible_hits = self.stun_delta_hits.max(self.stun_message_hits);
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
            target_current_hp: None,
            target_max_hp: None,
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
            target_current_hp: None,
            target_max_hp: None,
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
            target_current_hp: None,
            target_max_hp: None,
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
    fn tracks_per_enemy_type_target_breakdown() {
        use crate::parser::constants::EnemyType;

        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        // Two hits on enemy type 0xAAAA (different spawn indexes merge by type),
        // one hit on enemy type 0xBBBB.
        let mut e1 = make_event(100, None, None);
        e1.target.parent_actor_type = 0xAAAA;
        e1.target.index = 1;
        let mut e2 = make_event(50, None, None);
        e2.target.parent_actor_type = 0xAAAA;
        e2.target.index = 2;
        let mut e3 = make_event(25, None, None);
        e3.target.parent_actor_type = 0xBBBB;
        e3.target.index = 3;

        for event in [&e1, &e2, &e3] {
            skill_state
                .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(event, None));
        }

        assert_eq!(skill_state.targets.len(), 2);
        let a = skill_state
            .targets
            .iter()
            .find(|target| target.enemy_type == EnemyType::Unknown(0xAAAA))
            .unwrap();
        assert_eq!(a.hits, 2);
        assert_eq!(a.total_damage, 150);
        let b = skill_state
            .targets
            .iter()
            .find(|target| target.enemy_type == EnemyType::Unknown(0xBBBB))
            .unwrap();
        assert_eq!(b.hits, 1);
        assert_eq!(b.total_damage, 25);
    }

    #[test]
    fn counts_stun_eligible_hits_on_the_delta_path() {
        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        // A hit that actually applied stun counts; a stun-capable hit that dealt
        // 0 stun (target stunned/immune) does not.
        skill_state.add_stun_delta(12.0);
        skill_state.add_stun_delta(0.0);
        skill_state.add_stun_delta(8.0);

        assert_eq!(skill_state.stun_eligible_hits, 2);
        assert_eq!(skill_state.total_stun_value, 20.0);
    }

    #[test]
    fn counts_stun_eligible_hits_on_the_message_path() {
        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        // Online: stun arrives as attributed messages, per-hit deltas are 0.
        skill_state.add_stun_message(30.0);
        skill_state.add_stun_message(0.0);
        skill_state.add_stun_message(30.0);

        assert_eq!(skill_state.stun_eligible_hits, 2);
        assert_eq!(skill_state.total_stun_value, 60.0);
    }

    #[test]
    fn stun_eligible_hits_max_dedupes_delta_and_message_paths() {
        // Solo loopback fires BOTH paths for the same accruals; max() over the
        // per-path counts (mirroring total_stun_value's max over the sums) keeps
        // the count from doubling.
        let mut skill_state = SkillState::new(ActionType::Normal(1), CharacterType::Pl0000);

        skill_state.add_stun_delta(10.0);
        skill_state.add_stun_delta(10.0);
        skill_state.add_stun_message(10.0);
        skill_state.add_stun_message(10.0);

        assert_eq!(skill_state.stun_eligible_hits, 2);
    }

    #[test]
    fn supplementary_and_dot_hits_are_not_stun_eligible() {
        // Supplementary echoes and DoT ticks never proc stun, so their per-hit
        // stun is 0 and they never count toward the eligible-hit denominator.
        let mut supp = SkillState::new(ActionType::SupplementaryDamage(1), CharacterType::Pl0000);
        let mut supp_event = make_event(5_000, None, None);
        supp_event.action_id = ActionType::SupplementaryDamage(1);
        supp.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&supp_event, None));

        let mut dot = SkillState::new(ActionType::DamageOverTime(0), CharacterType::Pl0000);
        let mut dot_event = make_event(1_000, None, None);
        dot_event.action_id = ActionType::DamageOverTime(0);
        dot.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&dot_event, None));

        assert_eq!(supp.stun_eligible_hits, 0);
        assert_eq!(dot.stun_eligible_hits, 0);
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
