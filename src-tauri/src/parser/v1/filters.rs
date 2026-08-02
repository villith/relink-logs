//! Which damage the meters count.
//!
//! Some damage sources are contested — whether a Primal Burst belongs in a DPS
//! number is a question the community is still answering — so the app keeps
//! them out of every derived total by default and lets the user opt in.
//!
//! The rule lives here, on the raw [`DamageEvent`], because derived numbers are
//! built from those events in three separate places: the live overlay's
//! incremental accumulation, the saved-log reparse, and the logs page's DPS
//! chart. One predicate keeps the three from disagreeing.
//!
//! The raw event log is never filtered. It is the source of truth and every
//! total is rebuilt from it, which is what makes these toggles retroactive —
//! flipping one re-derives logs recorded long before the user changed their
//! mind, in both directions.

use protocol::{ActionType, DamageEvent, PRIMAL_BURST_BODY_HASHES, SUMMON_ATTACK_ACTION_ID};
use serde::{Deserialize, Serialize};

/// The contested damage sources the meters are currently counting.
///
/// Every flag reads as "include", so [`Default`] — all false — is the shipped
/// behaviour: contested damage stays out until the user asks for it. That also
/// makes an absent or legacy input default to excluding rather than to silently
/// counting.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeterFilters {
    /// Count Primal Burst damage toward every damage, stun and chart total.
    pub include_primal_burst: bool,
}

/// True when `event` must not reach any derived total.
pub fn is_excluded(event: &DamageEvent, filters: &MeterFilters) -> bool {
    !filters.include_primal_burst && is_primal_burst(event)
}

/// Which events the *selector bar* keeps, as opposed to [`MeterFilters`] which
/// decides what counts at all.
///
/// Empty means "All" for that dimension. The fields are ANDed: an event must
/// satisfy every non-empty dimension. Kept separate from `MeterFilters` because
/// these are a view concern the user changes constantly, while those are a
/// settings concern that changes what a total *means*.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SelectionFilter {
    /// Source actor indices to keep (empty = all).
    ///
    /// The INDEX, not the actor-type hash: a hash names a character class, and
    /// an online party can hold two of the same character, which a hash would
    /// silently merge into one row. The index is unique per player in a fight
    /// and is what the derived party is already keyed by.
    pub source_indices: Vec<u32>,
    /// Actions to keep (empty = all).
    pub abilities: Vec<ActionType>,
}

/// True when `event` survives the current selector pins.
///
/// Source matches on `parent_index`, not `index`: a summon's hit belongs to the
/// player who called it, and pinning that player must keep it.
pub fn matches_selection(event: &DamageEvent, selection: &SelectionFilter) -> bool {
    if !selection.source_indices.is_empty()
        && !selection.source_indices.contains(&event.source.parent_index)
    {
        return false;
    }

    if !selection.abilities.is_empty() && !selection.abilities.contains(&event.action_id) {
        return false;
    }

    true
}

/// True for a hit dealt by one of the three Primal Burst body classes.
///
/// Matches on the SOURCE body (`source.actor_type`), not the summoner
/// (`parent_actor_type`): an ordinary summon call reports the same action id
/// from a different body and must not be caught by this.
fn is_primal_burst(event: &DamageEvent) -> bool {
    matches!(event.action_id, ActionType::Normal(id) if id == SUMMON_ATTACK_ACTION_ID)
        && PRIMAL_BURST_BODY_HASHES.contains(&event.source.actor_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Actor;

    /// The generic summon body every ordinary summon call spawns from
    /// (`BehaviorSummonObjectBase`). Shares the Primal Burst action id, so it is
    /// the case that proves the predicate keys on the body, not the action.
    const ORDINARY_SUMMON_BODY: u32 = 0xB0792857;

    /// A hit dealt by `body` with `action` as its skill id. Only those two
    /// fields matter to the predicate; the rest are inert.
    fn hit(body: u32, action: u32) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 1,
                actor_type: body,
                parent_index: 0,
                parent_actor_type: 0x28AC1108,
            },
            target: Actor {
                index: 9,
                actor_type: 0,
                parent_index: 9,
                parent_actor_type: 0,
            },
            damage: 1_000,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        }
    }

    #[test]
    fn default_filters_exclude_primal_burst() {
        let filters = MeterFilters::default();
        assert!(!filters.include_primal_burst, "off is the shipped default");
        assert!(is_excluded(
            &hit(PRIMAL_BURST_BODY_HASHES[0], SUMMON_ATTACK_ACTION_ID),
            &filters
        ));
    }

    #[test]
    fn every_primal_burst_body_is_excluded_when_off() {
        let filters = MeterFilters::default();
        for body in PRIMAL_BURST_BODY_HASHES {
            assert!(
                is_excluded(&hit(*body, SUMMON_ATTACK_ACTION_ID), &filters),
                "body {body:#x} should be excluded"
            );
        }
    }

    #[test]
    fn primal_burst_is_counted_when_included() {
        let filters = MeterFilters {
            include_primal_burst: true,
        };
        for body in PRIMAL_BURST_BODY_HASHES {
            assert!(
                !is_excluded(&hit(*body, SUMMON_ATTACK_ACTION_ID), &filters),
                "body {body:#x} should be counted"
            );
        }
    }

    #[test]
    fn ordinary_summon_body_is_never_excluded() {
        // Same action id, different body: a called summon is not a Primal Burst
        // and this toggle must not touch it.
        assert!(!is_excluded(
            &hit(ORDINARY_SUMMON_BODY, SUMMON_ATTACK_ACTION_ID),
            &MeterFilters::default()
        ));
    }

    #[test]
    fn primal_burst_body_with_another_action_is_not_excluded() {
        assert!(!is_excluded(
            &hit(PRIMAL_BURST_BODY_HASHES[0], 200),
            &MeterFilters::default()
        ));
    }

    #[test]
    fn empty_selection_matches_every_event() {
        let selection = SelectionFilter::default();
        assert!(matches_selection(
            &hit(ORDINARY_SUMMON_BODY, 200),
            &selection
        ));
    }

    #[test]
    fn source_filter_keys_on_the_parent_not_the_body() {
        // A summon's hit belongs to the player who summoned it, so pinning that
        // player must keep it. `hit` sets parent_index to 0 and index to 1.
        let selection = SelectionFilter {
            source_indices: vec![0],
            abilities: vec![],
        };
        assert!(matches_selection(
            &hit(ORDINARY_SUMMON_BODY, 200),
            &selection
        ));

        let other = SelectionFilter {
            source_indices: vec![3],
            abilities: vec![],
        };
        assert!(!matches_selection(&hit(ORDINARY_SUMMON_BODY, 200), &other));
    }

    #[test]
    fn ability_filter_matches_the_action_id() {
        let selection = SelectionFilter {
            source_indices: vec![],
            abilities: vec![ActionType::Normal(200)],
        };
        assert!(matches_selection(
            &hit(ORDINARY_SUMMON_BODY, 200),
            &selection
        ));
        assert!(!matches_selection(
            &hit(ORDINARY_SUMMON_BODY, 201),
            &selection
        ));
    }

    #[test]
    fn source_and_ability_are_anded() {
        let selection = SelectionFilter {
            source_indices: vec![0],
            abilities: vec![ActionType::Normal(999)],
        };
        // Source matches, ability does not — the event is out.
        assert!(!matches_selection(
            &hit(ORDINARY_SUMMON_BODY, 200),
            &selection
        ));
    }
}

