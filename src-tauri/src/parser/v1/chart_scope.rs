//! The gates every chart walk applies, in one value.
//!
//! Every chart builder in this module walks the same `raw_event_log` and must
//! decide which hits reach it. Passing those decisions as loose positional
//! arguments let each builder honour a different subset BY ACCIDENT: the
//! per-ability charts shipped ignoring the ability pin that the table honoured,
//! and the omission was invisible because a missing argument is just a shorter
//! signature. Three of the builders also carried
//! `#[allow(clippy::too_many_arguments)]`, which was the same problem measured
//! a different way.
//!
//! With one scope value, "which gates does this builder apply" is answered by
//! reading its uses of `scope` — and skipping one becomes a visible choice
//! rather than an absent parameter.

use protocol::{ActionType, DamageEvent};

use super::{is_excluded, target_selected, MeterFilters, PhantomTargets, PlayerData, TargetSpan};

/// Everything that narrows a chart walk.
///
/// Built once per request from `ParseOptions` and shared by every builder, so
/// the charts on one screen cannot answer for different fights.
pub struct ChartScope<'a> {
    /// The party roster, for the dragon-form remap and the local/remote rules.
    pub player_data: &'a [Option<PlayerData>; 4],
    /// Selected enemy spawn spans; empty = every target.
    pub target_spans: &'a [TargetSpan],
    /// The selector bar's ability pin, expanded to actions; empty = every
    /// ability. The same rule `matches_selection` applies to the derived state,
    /// so a chart drawn under a pin cannot disagree with the table beneath it.
    pub abilities: &'a [ActionType],
    /// Which contested damage sources count at all.
    pub filters: MeterFilters,
}

impl ChartScope<'_> {
    /// Whether this hit reaches the chart at all — every gate, in the order a
    /// builder with no special sequencing needs would apply them.
    ///
    /// Builders that must tell the gates apart (stun suppresses a trailing
    /// network message for an EXCLUDED hit but not for a merely unselected one)
    /// compose the individual predicates below instead. That is a deliberate
    /// choice they make from this same vocabulary, not a different one.
    pub fn admits(&self, rel_ts: i64, event: &DamageEvent, phantoms: &PhantomTargets) -> bool {
        !phantoms.is_phantom(event)
            && self.counted(event)
            && self.selects_ability(event.action_id)
            && self.selects_target(rel_ts, event)
    }

    /// Whether the meters count this hit at all (the contested-source filters).
    pub fn counted(&self, event: &DamageEvent) -> bool {
        !is_excluded(event, &self.filters)
    }

    /// Whether the ability pin admits this action. Empty pin = "All".
    pub fn selects_ability(&self, action: ActionType) -> bool {
        self.abilities.is_empty() || self.abilities.contains(&action)
    }

    /// Whether the target pin admits this hit. Empty selection = every target.
    pub fn selects_target(&self, rel_ts: i64, event: &DamageEvent) -> bool {
        target_selected(rel_ts, event, self.target_spans)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Actor, Message};

    fn a_damage_event(action: ActionType) -> DamageEvent {
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
            action_id: action,
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        }
    }

    fn no_phantoms() -> PhantomTargets {
        let none: Vec<(i64, Message)> = Vec::new();
        PhantomTargets::learned_from(none.iter())
    }

    fn scope<'a>(
        player_data: &'a [Option<PlayerData>; 4],
        abilities: &'a [ActionType],
    ) -> ChartScope<'a> {
        ChartScope {
            player_data,
            target_spans: &[],
            abilities,
            filters: MeterFilters::default(),
        }
    }

    #[test]
    fn an_empty_ability_pin_admits_every_action() {
        let players = [None, None, None, None];
        let scope = scope(&players, &[]);

        assert!(scope.selects_ability(ActionType::Normal(1)));
        assert!(scope.selects_ability(ActionType::LinkAttack));
    }

    #[test]
    fn a_pin_admits_only_its_own_actions() {
        let players = [None, None, None, None];
        let pinned = [ActionType::Normal(1)];
        let scope = scope(&players, &pinned);

        assert!(scope.selects_ability(ActionType::Normal(1)));
        assert!(!scope.selects_ability(ActionType::Normal(2)));
    }

    #[test]
    fn admits_applies_the_ability_pin() {
        // The gate whose omission was the bug this type exists to prevent.
        let players = [None, None, None, None];
        let pinned = [ActionType::Normal(1)];
        let scope = scope(&players, &pinned);
        let phantoms = no_phantoms();

        assert!(scope.admits(0, &a_damage_event(ActionType::Normal(1)), &phantoms));
        assert!(!scope.admits(0, &a_damage_event(ActionType::Normal(2)), &phantoms));
    }
}
