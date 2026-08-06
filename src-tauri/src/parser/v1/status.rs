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
    /// The applying status object's RTTI class, as a hash of its class NAME.
    /// Names the row's source where `ability_id` cannot — a passive has no
    /// action id, which is what a sentinel cause such as 9998 means.
    ///
    /// Payload, never part of the pairing key below: the shared scalar-deleting
    /// destructor resets the object's vftable back to `StatusBase` (that reset
    /// is what the hook's dtor signature anchors on), so the remove side cannot
    /// be relied on to report the same class. Keying on it would strand every
    /// removal and leave intervals open to the end of the fight.
    pub status_class: Option<u32>,
    /// The action the caster was performing when it applied this. Names the
    /// same rows one rung more specifically than the class does — the class
    /// names the mechanism, this names the ability.
    ///
    /// Payload only, for the reason `status_class` is, plus one more: it is
    /// INFERRED from what the caster was doing rather than recorded by the
    /// game, so keying on it would split rows by a guess.
    pub caster_action_id: Option<u32>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub max_stacks: u32,
    /// Which enemy SPAWN held this, as an index into the same response's
    /// `target_entries`. `None` for a player, and for an enemy the segmenter
    /// skipped (a phantom marker actor).
    ///
    /// The spawn, never the raw actor index, for the reason
    /// [`super::SelectionFact::target_segment`] gives: the game frees a dead
    /// boss's index and reissues it to the next one, so a debuff open when the
    /// first dragon died was extended by the second dragon's apply into a single
    /// row spanning both fights.
    pub target_segment: Option<usize>,
    /// How many times the effect landed within this window — the initial apply
    /// plus every refresh that extended it.
    ///
    /// Merging refreshes is what keeps uptime honest, but it also destroys the
    /// only record that they happened; a buff refreshed forty times and one
    /// applied once are the same single window otherwise. Summed across
    /// holders, this is the "Count" the tables show beside uptime.
    pub applications: u32,
}

/// The spawn an enemy actor index belonged to at `at_ms`.
///
/// `None` for a player — party slot keys are not spawns — and for an id the
/// segmenter never opened a segment for. An apply that precedes every segment
/// for its id belongs to the first of them: segments open on the first DAMAGE
/// event, so a debuff landing a moment before the enemy is first hit is
/// genuinely earlier than its own spawn's start.
///
/// Matched on [`super::TargetSegment::actor_index`] and NEVER on the segment's
/// `id`: the id is a folded instance pointer from the damage path, while a
/// status apply carries the game's actor index. Comparing the two compared
/// different namespaces, so it never matched and every enemy-held status lost
/// its spawn.
fn segment_at(segments: &[super::TargetSegment], actor_index: u32, at_ms: i64) -> Option<usize> {
    if protocol::is_player_slot_key(actor_index) {
        return None;
    }

    let mut first = None;
    let mut current = None;
    for (index, segment) in segments.iter().enumerate() {
        if segment.actor_index != actor_index {
            continue;
        }
        if first.is_none() {
            first = Some(index);
        }
        // Segments for one id are chronological and disjoint, so the last one
        // to have started by `at_ms` is the spawn that was alive then.
        if segment.start_ms <= at_ms {
            current = Some(index);
        }
    }
    current.or(first)
}

/// Closed intervals from apply/remove pairs in `events`.
///
/// `start_time` rebases timestamps; `fight_end_ms` closes anything still open
/// when the fight ended — a buff active at the kill emits no remove, and
/// dropping it would under-report uptime on the pull that mattered. An enemy's
/// interval closes at the end of its own SPAWN instead, so a debuff on a dying
/// boss is not reported as held for the minutes of fight that followed it.
///
/// `segments` is the same `target_entries` vector the response ships, so the
/// `target_segment` indices below point into it.
pub fn assemble_intervals(
    events: &[(i64, Message)],
    start_time: i64,
    fight_end_ms: i64,
    segments: &[super::TargetSegment],
) -> Vec<StatusInterval> {
    // Keyed on the full identity: actor, SPAWN, effect, and causing ability.
    // The spawn is part of it because the actor index alone is a recycled
    // handle — see `StatusInterval::target_segment`.
    let mut open: HashMap<(u32, Option<usize>, u32, Option<u32>), StatusInterval> = HashMap::new();
    let mut closed = Vec::new();

    for (ts, message) in events {
        let at = ts - start_time;

        match message {
            Message::StatusApply(event) => {
                let segment = segment_at(segments, event.actor_index, at);
                let key = (
                    event.actor_index,
                    segment,
                    event.status_id,
                    event.ability_id,
                );
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
                        status_class: event.status_class,
                        caster_action_id: event.caster_action_id,
                        start_ms: at,
                        // Provisional: a matched remove overwrites it. An enemy
                        // that never sends one is closed at its spawn's end
                        // rather than the fight's.
                        end_ms: segment
                            .and_then(|index| segments.get(index))
                            .map_or(fight_end_ms, |spawn| spawn.end_ms),
                        max_stacks: event.stacks,
                        target_segment: segment,
                        applications: 1,
                    });
            }
            Message::StatusRemove(event) => {
                let key = (
                    event.actor_index,
                    segment_at(segments, event.actor_index, at),
                    event.status_id,
                    event.ability_id,
                );
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
    // `ability_id` is part of the sort key, not just the identity: the still-open
    // intervals arrive in HashMap order, so without it two windows of one effect
    // from two causes tie and land in whichever order the hasher happened to
    // produce — a different order on each run of the same log.
    closed.sort_by_key(|i| {
        (
            i.start_ms,
            i.actor_index,
            i.target_segment,
            i.status_id,
            i.ability_id,
        )
    });
    closed
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Message, StatusApplyEvent, StatusRemoveEvent};

    fn apply(
        ts: i64,
        actor: u32,
        status: u32,
        ability: Option<u32>,
        stacks: u32,
    ) -> (i64, Message) {
        (
            ts,
            Message::StatusApply(StatusApplyEvent {
                actor_index: actor,
                caster_index: Some(0),
                status_id: status,
                ability_id: ability,
                status_class: None,
                caster_action_id: None,
                stacks,
            }),
        )
    }

    /// `apply` with the provenance fields attached, for the class tests. A
    /// separate helper rather than two more parameters on `apply`, which every
    /// other test in this module already calls.
    fn apply_with_provenance(
        ts: i64,
        actor: u32,
        status: u32,
        ability: Option<u32>,
        stacks: u32,
        status_class: Option<u32>,
        caster_action_id: Option<u32>,
    ) -> (i64, Message) {
        let (ts, message) = apply(ts, actor, status, ability, stacks);
        match message {
            Message::StatusApply(event) => (
                ts,
                Message::StatusApply(StatusApplyEvent {
                    status_class,
                    caster_action_id,
                    ..event
                }),
            ),
            other => (ts, other),
        }
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
        let events = vec![
            apply(0, 1, 10, Some(500), 1),
            remove(3_000, 1, 10, Some(500)),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

        assert_eq!(intervals.len(), 2, "per-actor, never merged");
        let actor_two = intervals.iter().find(|i| i.actor_index == 2).unwrap();
        assert_eq!(actor_two.end_ms, 10_000, "unclosed, so it runs to the end");
    }

    #[test]
    fn a_remove_with_no_apply_is_dropped() {
        // The capture can start mid-effect. A remove with nothing open has no
        // known start, and inventing one would fabricate uptime.
        let intervals = assemble_intervals(&[remove(1_000, 1, 10, Some(500))], 0, 10_000, &[]);
        assert!(intervals.is_empty());
    }

    #[test]
    fn a_remove_naming_a_different_cause_does_not_close_the_interval() {
        // The pairing contract, asserted rather than assumed: both emit sites in
        // the hook must read the cause the same way. Sending `None` from the
        // removal while the apply sent a real cause left every attributable
        // status open, so it ran to the end of the fight and reported ~100%
        // uptime. This is the test that fails if that regresses.
        let events = vec![apply(0, 1, 10, Some(500), 1), remove(3_000, 1, 10, None)];
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

        assert_eq!(intervals.len(), 1);
        assert_eq!(
            intervals[0].end_ms, 10_000,
            "a mismatched cause closes nothing, so the window runs to the fight's end"
        );
    }

    /// A spawn whose id and actor index are the same number.
    ///
    /// Only the time-resolution tests use this. The two are genuinely different
    /// namespaces in production — see
    /// [`a_debuff_resolves_by_actor_index_not_spawn_id`] — so a test that needs
    /// to tell them apart uses [`spawn_of`] instead.
    fn segment(id: u32, start_ms: i64, end_ms: i64) -> super::super::TargetSegment {
        spawn_of(id, id, start_ms, end_ms)
    }

    fn spawn_of(
        id: u32,
        actor_index: u32,
        start_ms: i64,
        end_ms: i64,
    ) -> super::super::TargetSegment {
        super::super::TargetSegment {
            id,
            actor_index,
            enemy_type: super::super::EnemyType::from_hash(0),
            instance: 1,
            max_hp: None,
            start_ms,
            end_ms,
        }
    }

    /// An enemy actor index. Distinct from a player slot key, which is what
    /// decides whether a holder is segmented at all.
    const ENEMY: u32 = 3_926_405_961;

    #[test]
    fn a_debuff_resolves_by_actor_index_not_spawn_id() {
        // The two capture paths name one enemy two different ways: a damage
        // event's `target.index` is its INSTANCE POINTER folded to 32 bits,
        // while a status apply carries the game's ACTOR INDEX (`+0x170`).
        // Matching a status's actor index against the spawn id compared values
        // from different namespaces, so it was never equal — measured on log
        // 1614, all 11 enemy-held intervals resolved to no spawn at all. The
        // debuff holder rows could not be named and the Enemy pin emptied the
        // table instead of narrowing it.
        //
        // These are the real values that log carries.
        const SPAWN_ID: u32 = 2_785_501_876;
        const ACTOR: u32 = 977_212_104;

        let segments = [spawn_of(SPAWN_ID, ACTOR, 0, 10_000)];
        let intervals =
            assemble_intervals(&[apply(0, ACTOR, 10, Some(500), 1)], 0, 20_000, &segments);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].target_segment, Some(0));
    }

    #[test]
    fn a_debuff_is_not_placed_on_a_spawn_that_merely_shares_its_number() {
        // The mirror of the above: the spawn id namespace must not be consulted
        // at all. A spawn whose folded pointer happens to equal some other
        // enemy's actor index would otherwise claim that enemy's debuffs.
        const ACTOR: u32 = 977_212_104;

        let segments = [spawn_of(ACTOR, 555, 0, 10_000)];
        let intervals =
            assemble_intervals(&[apply(0, ACTOR, 10, Some(500), 1)], 0, 20_000, &segments);

        assert_eq!(intervals[0].target_segment, None);
    }

    #[test]
    fn two_spawns_sharing_a_recycled_id_stay_separate() {
        // The Four Dragons case: the game frees a dead boss's actor index and
        // reissues it to the next one. Keyed on the index alone, the second
        // dragon's apply extended the first's still-open window into one row
        // spanning both fights.
        let segments = [segment(ENEMY, 0, 1_000), segment(ENEMY, 5_000, 9_000)];
        let events = vec![
            apply(0, ENEMY, 10, Some(500), 1),
            apply(5_000, ENEMY, 10, Some(500), 1),
        ];
        let intervals = assemble_intervals(&events, 0, 10_000, &segments);

        assert_eq!(intervals.len(), 2, "one spawn is not the other");
        assert_eq!(intervals[0].target_segment, Some(0));
        assert_eq!(intervals[1].target_segment, Some(1));
    }

    #[test]
    fn an_enemy_interval_closes_when_its_spawn_dies() {
        // A debuff on a dying boss emits no remove. Running it to the end of the
        // FIGHT would report the effect as held for minutes after the enemy
        // holding it stopped existing.
        let segments = [segment(ENEMY, 0, 1_000)];
        let intervals =
            assemble_intervals(&[apply(0, ENEMY, 10, Some(500), 1)], 0, 10_000, &segments);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].end_ms, 1_000);
    }

    #[test]
    fn a_player_holder_is_never_segmented() {
        // Segments are enemy spawns; a player has none, and an unclosed buff on
        // one still runs to the end of the fight.
        let player = protocol::player_slot_key(2);
        let segments = [segment(ENEMY, 0, 1_000)];
        let intervals =
            assemble_intervals(&[apply(0, player, 10, Some(500), 1)], 0, 10_000, &segments);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].target_segment, None);
        assert_eq!(intervals[0].end_ms, 10_000);
    }

    #[test]
    fn a_debuff_landing_before_the_first_hit_belongs_to_that_spawn() {
        // Segments open on the first DAMAGE event, so a debuff applied a moment
        // earlier precedes every segment for its id. It belongs to the spawn
        // about to be hit, not to nothing.
        let segments = [segment(ENEMY, 500, 4_000)];
        let intervals =
            assemble_intervals(&[apply(0, ENEMY, 10, Some(500), 1)], 0, 10_000, &segments);

        assert_eq!(intervals[0].target_segment, Some(0));
    }

    #[test]
    fn an_enemy_with_no_segment_at_all_keeps_its_interval() {
        // A phantom marker actor is deliberately skipped by the segmenter. Its
        // debuff has nowhere to belong, but dropping the interval would lose
        // uptime the capture really recorded.
        let intervals = assemble_intervals(&[apply(0, ENEMY, 10, Some(500), 1)], 0, 10_000, &[]);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].target_segment, None);
        assert_eq!(intervals[0].end_ms, 10_000);
    }

    #[test]
    fn a_fresh_interval_counts_one_application() {
        let intervals = assemble_intervals(&[apply(0, 1, 10, Some(500), 1)], 0, 10_000, &[]);
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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

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
        let intervals = assemble_intervals(&events, 0, 10_000, &[]);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].start_ms, 0);
        assert_eq!(intervals[0].end_ms, 3_000);
        assert_eq!(
            intervals[0].max_stacks, 2,
            "the refresh's stack count is kept"
        );
    }

    #[test]
    fn the_interval_carries_the_provenance_from_its_apply() {
        // Both fields are what names a row whose cause is a sentinel: 9998 means
        // no activated action produced the effect, so `ability_id` cannot.
        let events = vec![apply_with_provenance(
            0,
            1,
            10,
            Some(9998),
            1,
            Some(0xABCD),
            Some(1200),
        )];
        let intervals = assemble_intervals(&events, 0, 1_000, &[]);

        assert_eq!(intervals[0].status_class, Some(0xABCD));
        assert_eq!(intervals[0].caster_action_id, Some(1200));
    }

    #[test]
    fn a_remove_still_closes_an_interval_that_has_provenance() {
        // Neither field may join the pairing key. The shared scalar-deleting
        // destructor resets the object's vftable back to `StatusBase` before the
        // remove hook could read it — that reset is literally what the hook's
        // dtor signature anchors on — so a remove cannot supply the same class.
        // Keyed on it, this remove would not match and the interval would stay
        // open to the end of the fight.
        let events = vec![
            apply_with_provenance(0, 1, 10, Some(9998), 1, Some(0xABCD), Some(1200)),
            remove(500, 1, 10, Some(9998)),
        ];
        let intervals = assemble_intervals(&events, 0, 1_000, &[]);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].end_ms, 500);
    }

    #[test]
    fn a_refresh_keeps_the_provenance_of_the_first_apply() {
        // Within one `(actor, spawn, effect, cause)` the parser still merges, so
        // the first class wins — the class splits rows ACROSS holders, not
        // within one window. Pinned so the merge behaviour is a decision rather
        // than an accident.
        let events = vec![
            apply_with_provenance(0, 1, 10, Some(9998), 1, Some(0xABCD), Some(1200)),
            apply_with_provenance(500, 1, 10, Some(9998), 1, Some(0x1234), Some(1300)),
        ];
        let intervals = assemble_intervals(&events, 0, 1_000, &[]);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].status_class, Some(0xABCD));
        assert_eq!(intervals[0].caster_action_id, Some(1200));
    }
}
