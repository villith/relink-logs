use protocol::{ActionType, DamageEvent};
use serde::{Deserialize, Serialize};

use crate::parser::constants::{CharacterType, FerrySkillId};

use super::{skill_state::ProcKind, skill_state::SkillState, AdjustedDamageInstance};

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
    /// Number of hits by this player that reached the game's damage cap
    pub capped_hits: u32,
    /// Number of hits that were subject to a damage cap at all — the denominator
    /// for the cap percentage. Cap-less sources (supplementary damage, DoT) are
    /// excluded so they can't dilute the percentage.
    #[serde(default)]
    pub cappable_hits: u32,
}

impl PlayerState {
    pub fn set_sba(&mut self, sba: f64) {
        self.sba = sba;
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
        if damage_instance.is_capped {
            self.capped_hits += 1;
        }
        self.total_damage += damage_instance.event.damage as u64;
        self.total_stun_value += damage_instance.stun_damage;

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

        // Supplementary-type procs: attribute to the skill row that triggered
        // them (the proc carries the trigger's action id), then merge into the
        // shared Supplementary Damage row as before. Classification is by
        // damage ratio — the event stream has no other discriminator.
        if let protocol::ActionType::SupplementaryDamage(trigger_aid) = action {
            let event = damage_instance.event;
            if let Some(idx) = self.skill_breakdown.iter().position(|s| {
                s.action_type == ActionType::Normal(trigger_aid)
                    && s.child_character_type == child_character_type
            }) {
                let row = &mut self.skill_breakdown[idx];
                match row.classify_proc(event.damage, event.target.index, event.target.actor_type)
                {
                    ProcKind::Supplementary => {
                        row.supp_hits += 1;
                        row.supp_damage += event.damage as u64;
                    }
                    ProcKind::Echo => {
                        row.echo_hits += 1;
                        row.echo_damage += event.damage as u64;
                    }
                }
            }

            if let Some(merged) = self
                .skill_breakdown
                .iter_mut()
                .find(|s| matches!(s.action_type, protocol::ActionType::SupplementaryDamage(_)))
            {
                merged.update_from_damage_event(damage_instance);
            } else {
                let mut skill = SkillState::new(action, child_character_type);
                skill.update_from_damage_event(damage_instance);
                self.skill_breakdown.push(skill);
            }
            return;
        }

        // If the skill is already being tracked, update it.
        for skill in self.skill_breakdown.iter_mut() {
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

    /// Recount capped hits against newly-learned crit multipliers. Every damage
    /// event increments the player counters and exactly one skill row, so the
    /// player total is the sum of its skills.
    pub fn reclassify_caps(&mut self, crit_multipliers: &[f64]) {
        let mut capped = 0;
        for skill in self.skill_breakdown.iter_mut() {
            skill.reclassify_caps(crit_multipliers);
            capped += skill.capped_hits;
        }
        self.capped_hits = capped;
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::v1::{PlayerData, PlayerStats};

    use super::*;

    #[test]
    fn calculates_dps() {
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 100,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

        player_state.update_dps(1000, 0);

        assert_eq!(player_state.dps, 100.0);
    }

    #[test]
    fn updates_from_damage_event() {
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            stun_per_second: 0.0,
            total_stun_value: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            stun_per_second: 0.0,
            total_stun_value: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        };

        let player_data = PlayerData {
            actor_index: 0,
            character_type: CharacterType::Pl0000,
            display_name: "Test".to_string(),
            character_name: "Test".to_string(),
            sigils: Vec::new(),
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
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
        }
    }

    #[test]
    fn counts_player_capped_hits_across_skills() {
        let mut player_state = PlayerState {
            index: 0,
            character_type: CharacterType::Pl0000,
            total_damage: 0,
            last_known_pet_skill: None,
            dps: 0.0,
            skill_breakdown: vec![],
            sba: 0.0,
            total_stun_value: 0.0,
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
        };

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
            stun_per_second: 0.0,
            capped_hits: 0,
            cappable_hits: 0,
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
        }
    }

    fn apply(player: &mut PlayerState, event: &DamageEvent) {
        player.update_from_damage_event(&AdjustedDamageInstance::from_damage_event(event, None));
    }

    #[test]
    fn supplementary_proc_attributes_to_trigger_skill() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 200),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        assert_eq!(trigger.supp_hits, 1);
        assert_eq!(trigger.supp_damage, 200);
        assert_eq!(trigger.echo_hits, 0);
        // The trigger row's own hit stats are untouched by the proc.
        assert_eq!(trigger.hits, 1);
        assert_eq!(trigger.total_damage, 1000);

        // The merged Supplementary Damage row still aggregates as before.
        let merged = player
            .skill_breakdown
            .iter()
            .find(|s| matches!(s.action_type, ActionType::SupplementaryDamage(_)))
            .unwrap();
        assert_eq!(merged.hits, 1);
        assert_eq!(merged.total_damage, 200);
        assert_eq!(player.total_damage, 1200);
    }

    #[test]
    fn echo_proc_classified_by_ratio() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 400),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        assert_eq!(trigger.echo_hits, 1);
        assert_eq!(trigger.echo_damage, 400);
        assert_eq!(trigger.supp_hits, 0);
    }

    #[test]
    fn proc_without_matching_skill_row_only_merges() {
        let mut player = empty_player();
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(99), 200),
        );

        // Only the merged row exists; nothing was attributed anywhere.
        assert_eq!(player.skill_breakdown.len(), 1);
        let merged = &player.skill_breakdown[0];
        assert!(matches!(
            merged.action_type,
            ActionType::SupplementaryDamage(_)
        ));
        assert_eq!(merged.total_damage, 200);
        assert_eq!(merged.supp_hits, 0);
        assert_eq!(merged.echo_hits, 0);
    }

    #[test]
    fn multiple_procs_accumulate() {
        let mut player = empty_player();
        apply(&mut player, &plain_event(ActionType::Normal(1), 1000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 200),
        );
        apply(&mut player, &plain_event(ActionType::Normal(1), 2000));
        apply(
            &mut player,
            &plain_event(ActionType::SupplementaryDamage(1), 800),
        );

        let trigger = player
            .skill_breakdown
            .iter()
            .find(|s| s.action_type == ActionType::Normal(1))
            .unwrap();
        // 200/1000 = 0.2 -> supp; 800/2000 = 0.4 -> echo.
        assert_eq!(trigger.supp_hits, 1);
        assert_eq!(trigger.supp_damage, 200);
        assert_eq!(trigger.echo_hits, 1);
        assert_eq!(trigger.echo_damage, 800);
        // Merged row got both procs.
        let merged = player
            .skill_breakdown
            .iter()
            .find(|s| matches!(s.action_type, ActionType::SupplementaryDamage(_)))
            .unwrap();
        assert_eq!(merged.hits, 2);
        assert_eq!(merged.total_damage, 1000);
    }
}
