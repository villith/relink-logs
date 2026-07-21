use protocol::{ActionType, DamageEvent};
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, FerrySkillId};

use super::{skill_state::SkillState, AdjustedDamageInstance};

/// Derived stat breakdown for a player
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub index: u32,
    pub character_type: CharacterType,
    pub total_damage: u64,
    pub last_known_pet_skill: Option<ActionType>, // used for Ferry's skills that don't keep track of where they came from
    pub dps: f64,
    pub skill_breakdown: Vec<SkillState>,
    pub sba: f64,
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
    pub fn set_sba(&mut self, sba: f64) {
        self.sba = sba;
    }

    /// Folds one network stun message into this player's totals.
    pub fn add_stun_message(&mut self, amount: f64) {
        self.stun_message_sum += amount;
        self.refresh_total_stun();
    }

    /// `total_stun_value` = whichever capture path saw the accrual (they
    /// measure the same accumulator, so max() dedupes them).
    fn refresh_total_stun(&mut self) {
        self.total_stun_value = self.stun_delta_sum.max(self.stun_message_sum);
    }

    pub fn update_dps(&mut self, now: i64, start_time: i64) {
        self.dps = self.total_damage as f64 / ((now - start_time) as f64 / 1000.0);
        self.stun_per_second = self.total_stun_value / ((now - start_time) as f64 / 1000.0);
    }

    // @todo(false): maybe Ferry specific stuff can be removed/abstracted if some extra flags are found or the attribution is fixed
    pub fn get_action_from_ferry_damage_event(&mut self, event: &DamageEvent) -> ActionType {
        // Ferry needs special handling because the action_id that comes back for pet skills is usually wrong
        // e.g. if you strafe then dodge the action_id for further hits comes back as "dodge"
        let is_ferry_pet =
            CharacterType::Pl0700Ghost == CharacterType::from_hash(event.source.actor_type);
        let is_ferry_pet_skill = is_ferry_pet && (event.flags & (1 << 2) != 0); // pet skills for ferry always have this flag set
        let is_ferry_pet_normal =
            is_ferry_pet && !is_ferry_pet_skill && event.action_id != ActionType::LinkAttack;

        // Umlauf excluded since that uses a separate actor which works correctly
        if is_ferry_pet_skill
            && vec![
                FerrySkillId::BlausGespenst,
                FerrySkillId::Pendel,
                FerrySkillId::Strafe,
            ]
            .into_iter()
            .any(|skill_id| ActionType::Normal(skill_id as u32) == event.action_id)
        {
            self.last_known_pet_skill = Some(event.action_id);
        }

        const PET_NORMAL: ActionType = ActionType::Normal(FerrySkillId::PetNormal as u32);

        if is_ferry_pet_normal {
            // Note technically the pet portion of Onslaught will count as a Pet normal, but I think that's fine since
            // it does exactly as much as a pet normal. Could consider adding Onslaught (pet) as a separate category
            PET_NORMAL
        } else if is_ferry_pet_skill {
            match self.last_known_pet_skill {
                None => PET_NORMAL, // May be good to instead have a separate "pet skill" backup for this case
                Some(skill_id) => skill_id,
            }
        } else {
            event.action_id
        }
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

        let parent_character_type =
            CharacterType::from_hash(damage_instance.event.source.parent_actor_type);

        // @TODO(false): Collapse all skill IDs from Seofon's avatar into his own.
        let child_character_type = if parent_character_type == CharacterType::Pl2200 {
            parent_character_type
        } else {
            CharacterType::from_hash(damage_instance.event.source.actor_type)
        };

        // for ferry defer to special function to handle the weird way her pets work
        let action = if parent_character_type == CharacterType::Pl0700 {
            self.get_action_from_ferry_damage_event(damage_instance.event)
        } else {
            damage_instance.event.action_id
        };

        // If the skill is already being tracked, update it.
        for skill in self.skill_breakdown.iter_mut() {
            // Aggregate all supplementary damage events into the same skill instance.
            if matches!(
                skill.action_type,
                protocol::ActionType::SupplementaryDamage(_)
            ) && matches!(action, protocol::ActionType::SupplementaryDamage(_))
            {
                skill.update_from_damage_event(damage_instance);
                return;
            }

            // Same for damage-over-time. Since the 2.0.2 hook fix the payload is the DoT
            // TYPE (0 poison / 1 burn / 2 darkburn) rather than a constant 0, so keying on
            // equality below would open one row per type — and `getSkillName` renders them
            // all through the single `skills.<char>.damage-over-time` key, so the user would
            // see two or three identically-named rows with the damage split between them.
            // The type stays in the raw event log for whenever the UI learns to name them.
            if matches!(skill.action_type, protocol::ActionType::DamageOverTime(_))
                && matches!(action, protocol::ActionType::DamageOverTime(_))
            {
                skill.update_from_damage_event(damage_instance);
                return;
            }

            // If the skill is already being tracked, update it.
            if skill.action_type == action && skill.child_character_type == child_character_type {
                skill.update_from_damage_event(damage_instance);
                return;
            }
        }

        // Otherwise, create a new skill and track it.
        let mut skill = SkillState::new(action, child_character_type);

        skill.update_from_damage_event(damage_instance);
        self.skill_breakdown.push(skill);
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::v1::{PlayerData, PlayerStats};

    use super::*;

    #[test]
    fn calculates_dps() {
        let mut player_state = empty_player();
        player_state.total_damage = 100;

        player_state.update_dps(1000, 0);

        assert_eq!(player_state.dps, 100.0);
    }

    /// Regression: the 2.0.2 DoT hook fix made the `DamageOverTime` payload the DoT TYPE
    /// (0 poison / 1 burn / 2 darkburn) instead of a constant 0. Keying skill rows on
    /// action-type equality then opened one row per type — and every one of them renders
    /// through the same fixed `damage-over-time` i18n key, so the breakdown showed two
    /// identically-named rows with the damage split between them.
    #[test]
    fn all_damage_over_time_types_share_one_skill_row() {
        let mut player_state = empty_player();

        for (dot_type, damage) in [(0u32, 100), (1, 50), (2, 25), (0, 25)] {
            let event = plain_event(ActionType::DamageOverTime(dot_type), damage);
            player_state
                .update_from_damage_event(&AdjustedDamageInstance::from_damage_event(&event, None));
        }

        assert_eq!(
            player_state.skill_breakdown.len(),
            1,
            "poison/burn/darkburn stay one row"
        );
        assert_eq!(player_state.skill_breakdown[0].hits, 4);
        assert_eq!(player_state.skill_breakdown[0].total_damage, 200);
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
        PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_delta_sum: 0.0,
            stun_message_sum: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
            overcap_base_sum: 0.0,
            overcap_cap_sum: 0.0,
        }
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
}
