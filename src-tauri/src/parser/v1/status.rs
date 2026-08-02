//! Status-effect intervals.
//!
//! A buff's identity is `(status_id, ability_id)` — the effect AND the ability
//! that caused it — because two abilities granting the same effect must stay
//! distinguishable in the UI. Intervals are per actor and never merged: a
//! merged union cannot be un-merged, and pinning a buff must show which
//! players actually had it.

use std::collections::HashMap;

use protocol::Message;
use serde::Serialize;

/// One continuous window during which one actor held one effect.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusInterval {
    pub actor_index: u32,
    pub caster_index: Option<u32>,
    pub status_id: u32,
    /// The causing ability. `None` when the hook could not resolve it — the UI
    /// then labels the row with the bare effect name.
    pub ability_id: Option<u32>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub max_stacks: u32,
    /// How many times the effect landed within this window — the initial apply
    /// plus every refresh that extended it.
    ///
    /// Merging refreshes is what keeps uptime honest, but it also destroys the
    /// only record that they happened; a buff refreshed forty times and one
    /// applied once are the same single window otherwise. Summed across
    /// holders, this is the "Count" the tables show beside uptime.
    pub applications: u32,
}

/// Closed intervals from apply/remove pairs in `events`.
///
/// `start_time` rebases timestamps; `fight_end_ms` closes anything still open
/// when the fight ended — a buff active at the kill emits no remove, and
/// dropping it would under-report uptime on the pull that mattered.
pub fn assemble_intervals(
    events: &[(i64, Message)],
    start_time: i64,
    fight_end_ms: i64,
) -> Vec<StatusInterval> {
    // Keyed on the full identity: actor, effect, AND causing ability.
    let mut open: HashMap<(u32, u32, Option<u32>), StatusInterval> = HashMap::new();
    let mut closed = Vec::new();

    for (ts, message) in events {
        let at = ts - start_time;

        match message {
            Message::StatusApply(event) => {
                let key = (event.actor_index, event.status_id, event.ability_id);
                open.entry(key)
                    .and_modify(|existing| {
                        // A refresh: extend, never open a second overlapping
                        // interval, which would double-count uptime. The count
                        // is the only place the refresh survives.
                        existing.max_stacks = existing.max_stacks.max(event.stacks);
                        existing.applications = existing.applications.saturating_add(1);
                    })
                    .or_insert(StatusInterval {
                        actor_index: event.actor_index,
                        caster_index: event.caster_index,
                        status_id: event.status_id,
                        ability_id: event.ability_id,
                        start_ms: at,
                        end_ms: fight_end_ms,
                        max_stacks: event.stacks,
                        applications: 1,
                    });
            }
            Message::StatusRemove(event) => {
                let key = (event.actor_index, event.status_id, event.ability_id);
                // A remove with nothing open has no known start — the capture
                // can begin mid-effect, and inventing a start fabricates uptime.
                if let Some(mut interval) = open.remove(&key) {
                    interval.end_ms = at;
                    closed.push(interval);
                }
            }
            _ => {}
        }
    }

    closed.extend(open.into_values());
    closed.sort_by_key(|i| (i.start_ms, i.actor_index, i.status_id));
    closed
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Message, StatusApplyEvent, StatusRemoveEvent};

    fn apply(ts: i64, actor: u32, status: u32, ability: Option<u32>, stacks: u32) -> (i64, Message) {
        (
            ts,
            Message::StatusApply(StatusApplyEvent {
                actor_index: actor,
                caster_index: Some(0),
                status_id: status,
                ability_id: ability,
                stacks,
            }),
        )
    }

    fn remove(ts: i64, actor: u32, status: u32, ability: Option<u32>) -> (i64, Message) {
        (
            ts,
            Message::StatusRemove(StatusRemoveEvent {
                actor_index: actor,
                status_id: status,
                ability_id: ability,
            }),
        )
    }

    #[test]
    fn a_matched_pair_becomes_one_closed_interval() {
        let events = vec![apply(0, 1, 10, Some(500), 1), remove(3_000, 1, 10, Some(500))];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].start_ms, 0);
        assert_eq!(intervals[0].end_ms, 3_000);
        assert_eq!(intervals[0].actor_index, 1);
    }

    #[test]
    fn an_unclosed_interval_runs_to_the_end_of_the_fight() {
        // A buff still active when the boss dies emits no remove. Dropping it
        // would under-report uptime on exactly the pull that mattered.
        let events = vec![apply(1_000, 1, 10, Some(500), 1)];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].end_ms, 10_000);
    }

    #[test]
    fn the_same_effect_from_two_abilities_stays_separate() {
        // The whole point of the contract: identity is (status, ability).
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            apply(0, 1, 10, Some(600), 1),
            remove(1_000, 1, 10, Some(500)),
            remove(2_000, 1, 10, Some(600)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 2);
        assert_eq!(
            intervals
                .iter()
                .filter(|i| i.ability_id == Some(500))
                .count(),
            1
        );
    }

    #[test]
    fn each_actor_keeps_its_own_interval() {
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            apply(500, 2, 10, Some(500), 1),
            remove(1_000, 1, 10, Some(500)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 2, "per-actor, never merged");
        let actor_two = intervals.iter().find(|i| i.actor_index == 2).unwrap();
        assert_eq!(actor_two.end_ms, 10_000, "unclosed, so it runs to the end");
    }

    #[test]
    fn a_remove_with_no_apply_is_dropped() {
        // The capture can start mid-effect. A remove with nothing open has no
        // known start, and inventing one would fabricate uptime.
        let intervals = assemble_intervals(&[remove(1_000, 1, 10, Some(500))], 0, 10_000);
        assert!(intervals.is_empty());
    }

    #[test]
    fn a_fresh_interval_counts_one_application() {
        let intervals = assemble_intervals(&[apply(0, 1, 10, Some(500), 1)], 0, 10_000);
        assert_eq!(intervals[0].applications, 1);
    }

    #[test]
    fn every_refresh_counts_as_another_application() {
        // The count the Buffs table shows is "how many times did this land",
        // which is the number a merged interval would otherwise destroy: three
        // applies collapse into one window, and without this the row would
        // claim the effect landed once.
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            apply(1_000, 1, 10, Some(500), 1),
            apply(2_000, 1, 10, Some(500), 1),
            remove(3_000, 1, 10, Some(500)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].applications, 3);
    }

    #[test]
    fn a_reopened_effect_starts_counting_again() {
        // Two separate windows are two rows' worth of interval, each with its
        // own count — carrying the first window's total into the second would
        // double-count it once the table sums them.
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            remove(1_000, 1, 10, Some(500)),
            apply(2_000, 1, 10, Some(500), 1),
            remove(3_000, 1, 10, Some(500)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 2);
        assert_eq!(intervals[0].applications, 1);
        assert_eq!(intervals[1].applications, 1);
    }

    #[test]
    fn a_reapply_before_removal_extends_rather_than_duplicating() {
        // Refreshing a buff re-fires apply without a remove. Two overlapping
        // intervals would double-count uptime.
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            apply(1_000, 1, 10, Some(500), 2),
            remove(3_000, 1, 10, Some(500)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].start_ms, 0);
        assert_eq!(intervals[0].end_ms, 3_000);
        assert_eq!(intervals[0].max_stacks, 2, "the refresh's stack count is kept");
    }
}
