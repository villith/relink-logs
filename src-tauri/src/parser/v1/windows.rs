//! Chart windows: spans of fight time during which a party-wide (or
//! per-enemy) battle state held — Link Time, an SBA performance, an enemy's
//! Break — assembled from the transition events the hook records. The
//! analysis chart shades them behind its series, the way the aura filter's
//! bands already shade exclusions.
//!
//! Assembled on read from the raw event log (like `assemble_intervals`), so
//! nothing has to hold open windows across a reparse and older logs simply
//! produce none.

use protocol::{ActionType, Message};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChartWindowKind {
    /// A Skybound Art performance (chained arts extend one window).
    Sba,
    /// Link Time.
    Link,
    /// An enemy sitting in Break after its overdrive gauge depleted.
    Break,
}

/// One shaded span, in milliseconds relative to the fight's start — the same
/// clock `StatusInterval` reports on.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChartWindow {
    pub kind: ChartWindowKind,
    pub start_ms: i64,
    pub end_ms: i64,
    /// The breaking enemy's actor index for `Break` windows (so two bosses'
    /// breaks stay distinguishable in a tooltip); `None` for the party-wide
    /// kinds.
    pub actor_index: Option<u32>,
}

/// Corroboration window for an activation event (perform/chain): same-actor
/// SBA damage this close vouches for it. Live data (logs 1783–1792,
/// 2026-08-05): a real art's damage starts up to ~2.5s BEFORE its perform
/// lands and its finisher lands within ~1s after it — while the boundary-noise
/// performs (a Repeat Quest start re-firing the previous fight's leftover
/// casting state, e.g. logs 1786/1787 at t≈0) sit minutes from any SBA damage.
const SBA_CORROBORATION_BEFORE_MS: i64 = 5_000;
const SBA_CORROBORATION_AFTER_MS: i64 = 10_000;

/// Gap that separates two SBA activity clusters. Within one art the largest
/// observed lull between hits is ~4.0s and between one art's finisher and the
/// next chained art's opener ~3.0s (same logs); independent arts sit tens of
/// seconds apart. Two arts closer than this merge — which is also the honest
/// shading, since each art disables the boss for its own stretch.
const SBA_CLUSTER_GAP_MS: i64 = 8_000;

/// The raw-log indexes of the activation events (`OnPerformSBA` /
/// `OnContinueSBAChain`) that same-actor SBA damage corroborates.
///
/// The perform capture is a per-frame collision check, and at a Repeat Quest
/// boundary the previous fight's leftover casting state can fire it once with
/// nothing behind it — a phantom "X used their art" at the first millisecond
/// of the next log. A real art ALWAYS records damage from its performer close
/// by (see the constants above), so an activation with none is dropped — by
/// the SBA windows here and by `fetch_encounter_state`'s `sba_events` (the
/// chart markers), which must agree on which activations were real.
pub fn corroborated_sba_activations(events: &[(i64, Message)]) -> HashSet<usize> {
    // Every SBA hit's (timestamp, performer), in log order.
    let sba_damage: Vec<(i64, u32)> = events
        .iter()
        .filter_map(|(ts, message)| match message {
            Message::DamageEvent(event) if event.action_id == ActionType::SBA => {
                Some((*ts, event.source.parent_index))
            }
            _ => None,
        })
        .collect();

    events
        .iter()
        .enumerate()
        .filter_map(|(index, (ts, message))| {
            let actor = match message {
                Message::OnPerformSBA(event) => event.actor_index,
                Message::OnContinueSBAChain(event) => event.actor_index,
                _ => return None,
            };
            sba_damage
                .iter()
                .any(|(damage_ts, performer)| {
                    *performer == actor
                        && *damage_ts >= ts - SBA_CORROBORATION_BEFORE_MS
                        && *damage_ts <= ts + SBA_CORROBORATION_AFTER_MS
                })
                .then_some(index)
        })
        .collect()
}

/// Walks the raw log and pairs each state's transitions into windows.
///
/// Link and Break come from the hook's latched transition events; the walk
/// still tolerates repeats (a re-sent `active=true` extends nothing) and a
/// window still open at the last event closes at `fight_end_ms` — the state
/// genuinely held to the end of what was recorded.
///
/// SBA windows are DERIVED, not captured, by CLUSTERING the log's SBA
/// activity: every SBA-typed damage event plus every corroborated activation
/// (see [`corroborated_sba_activations`]). An art is not a point — its damage
/// arrives as an opening hit, mid-animation ticks and a finisher, interleaved
/// with the perform event on a ±2.5s jitter — and a chain is arts back to
/// back, so consecutive activity closer than [`SBA_CLUSTER_GAP_MS`] is one
/// window: the stretch the boss is actually disabled for. A cluster of one
/// lone event has no width and draws nothing.
///
/// Every window's span is `[start, end)` — end-EXCLUSIVE, the wire mask's own
/// convention. Link and Break get that for free (their end is the state-exit
/// transition's timestamp), but an SBA cluster's last activity is its
/// finisher HIT, so the cluster closes one ms after it — otherwise filtering
/// by the window drops the finisher, typically its biggest hit.
pub fn assemble_chart_windows(
    events: &[(i64, Message)],
    start_time: i64,
    fight_end_ms: i64,
) -> Vec<ChartWindow> {
    let mut windows = Vec::new();
    let mut link_open: Option<i64> = None;
    // Per-enemy: the break's opening timestamp, keyed by actor index.
    let mut break_open: HashMap<u32, i64> = HashMap::new();
    // The open SBA cluster, as [first, last] activity timestamps.
    let mut sba_cluster: Option<(i64, i64)> = None;
    let corroborated = corroborated_sba_activations(events);

    for (index, (ts, message)) in events.iter().enumerate() {
        let at = ts - start_time;

        let sba_activity = match message {
            Message::DamageEvent(event) => event.action_id == ActionType::SBA,
            Message::OnPerformSBA(_) | Message::OnContinueSBAChain(_) => {
                corroborated.contains(&index)
            }
            _ => false,
        };
        if sba_activity {
            sba_cluster = Some(match sba_cluster {
                Some((first, last)) if at - last <= SBA_CLUSTER_GAP_MS => (first, at),
                Some((first, last)) => {
                    // A cluster of one lone event is a moment, not a span —
                    // the +1 close must not widen it into a 1ms window.
                    if last > first {
                        windows.push(window(ChartWindowKind::Sba, first, last + 1, None));
                    }
                    (at, at)
                }
                None => (at, at),
            });
        }

        match message {
            Message::LinkTime(event) => match (event.active, link_open) {
                (true, None) => link_open = Some(at),
                (false, Some(start)) => {
                    windows.push(window(ChartWindowKind::Link, start, at, None));
                    link_open = None;
                }
                _ => {}
            },
            Message::EnemyMode(event) => {
                let breaking = event.mode == protocol::EnemyModeEvent::MODE_BREAK;
                match (breaking, break_open.get(&event.actor_index).copied()) {
                    (true, None) => {
                        break_open.insert(event.actor_index, at);
                    }
                    (false, Some(start)) => {
                        windows.push(window(
                            ChartWindowKind::Break,
                            start,
                            at,
                            Some(event.actor_index),
                        ));
                        break_open.remove(&event.actor_index);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if let Some(start) = link_open {
        windows.push(window(ChartWindowKind::Link, start, fight_end_ms, None));
    }
    if let Some((first, last)) = sba_cluster {
        if last > first {
            windows.push(window(ChartWindowKind::Sba, first, last + 1, None));
        }
    }
    for (actor_index, start) in break_open {
        windows.push(window(
            ChartWindowKind::Break,
            start,
            fight_end_ms,
            Some(actor_index),
        ));
    }

    // A lone event is a moment, not a span — zero width draws nothing and
    // claims nothing.
    windows.retain(|w| w.end_ms > w.start_ms);
    windows.sort_by_key(|w| w.start_ms);
    windows
}

fn window(
    kind: ChartWindowKind,
    start_ms: i64,
    end_ms: i64,
    actor_index: Option<u32>,
) -> ChartWindow {
    ChartWindow {
        kind,
        // A clock skew or a state already active at the first event must not
        // produce a negative span.
        start_ms: start_ms.max(0),
        end_ms: end_ms.max(start_ms.max(0)),
        actor_index,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{
        Actor, DamageEvent, EnemyModeEvent, LinkTimeEvent, OnContinueSBAChainEvent,
        OnPerformSBAEvent,
    };

    fn link(ts: i64, active: bool) -> (i64, Message) {
        (ts, Message::LinkTime(LinkTimeEvent { active }))
    }

    fn mode(ts: i64, actor_index: u32, mode: u32) -> (i64, Message) {
        (ts, Message::EnemyMode(EnemyModeEvent { actor_index, mode }))
    }

    fn perform(ts: i64, actor_index: u32) -> (i64, Message) {
        (ts, Message::OnPerformSBA(OnPerformSBAEvent { actor_index }))
    }

    fn chain(ts: i64, actor_index: u32) -> (i64, Message) {
        (
            ts,
            Message::OnContinueSBAChain(OnContinueSBAChainEvent { actor_index }),
        )
    }

    fn sba_damage(ts: i64, actor_index: u32) -> (i64, Message) {
        (
            ts,
            Message::DamageEvent(DamageEvent {
                source: Actor {
                    index: actor_index,
                    actor_type: 0x2AF6_78E8,
                    parent_actor_type: 0x2AF6_78E8,
                    parent_index: actor_index,
                },
                target: Actor {
                    index: 1,
                    actor_type: 0,
                    parent_actor_type: 0,
                    parent_index: 1,
                },
                damage: 999,
                flags: 0,
                action_id: ActionType::SBA,
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
                instance_snapshot: None,
                source_snapshot: None,
            }),
        )
    }

    #[test]
    fn pairs_link_transitions_into_windows() {
        let events = vec![link(1_000, true), link(4_000, false)];
        let windows = assemble_chart_windows(&events, 0, 10_000);
        assert_eq!(
            windows,
            vec![ChartWindow {
                kind: ChartWindowKind::Link,
                start_ms: 1_000,
                end_ms: 4_000,
                actor_index: None
            }]
        );
    }

    #[test]
    fn one_art_spans_its_first_hit_to_its_finisher() {
        // The real shape (log 1786, slot 1): the opening hit lands BEFORE the
        // perform event, ticks follow, and the finisher lands ~8s after the
        // opener. The window is the whole stretch, whichever side of the
        // perform each hit fell on — closed one ms AFTER the finisher, so a
        // half-open `[start, end)` mask still admits the finisher itself
        // (log 1796: the chain's biggest hit lands at the exact last ms).
        let events = vec![
            sba_damage(187_183, 1),
            perform(189_203, 1),
            sba_damage(190_266, 1),
            sba_damage(191_500, 1),
            sba_damage(195_450, 1),
        ];
        let windows = assemble_chart_windows(&events, 0, 300_000);
        assert_eq!(
            windows,
            vec![ChartWindow {
                kind: ChartWindowKind::Sba,
                start_ms: 187_183,
                end_ms: 195_451,
                actor_index: None
            }]
        );
    }

    #[test]
    fn a_full_chain_is_one_window_spanning_every_art() {
        // Log 1785's full 4-burst, abbreviated: four performs seconds apart,
        // each art's damage clustered around its own perform, intra-art lulls
        // up to ~3s. One window, first hit to the last art's activity — the
        // boss is disabled for the whole chain.
        let events = vec![
            sba_damage(218_285, 0),
            perform(221_153, 0),
            sba_damage(225_573, 0),
            sba_damage(228_270, 1),
            // A chain-continue counts exactly like a perform (older logs and
            // online lobbies record them).
            chain(229_555, 1),
            sba_damage(231_104, 1),
            perform(233_371, 2),
            sba_damage(233_522, 2),
            sba_damage(237_020, 2),
            sba_damage(240_020, 3),
            sba_damage(243_521, 3),
            perform(244_527, 3),
        ];
        let windows = assemble_chart_windows(&events, 0, 300_000);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (218_285, 244_528));
    }

    #[test]
    fn two_separate_arts_are_two_windows() {
        let events = vec![
            sba_damage(20_000, 0),
            perform(21_000, 0),
            sba_damage(27_000, 0),
            sba_damage(60_000, 1),
            perform(61_000, 1),
            sba_damage(67_000, 1),
        ];
        let windows = assemble_chart_windows(&events, 0, 100_000);
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (20_000, 27_001));
        assert_eq!((windows[1].start_ms, windows[1].end_ms), (60_000, 67_001));
    }

    #[test]
    fn an_uncorroborated_perform_draws_nothing() {
        // The Repeat Quest boundary noise (logs 1786/1787): a lone perform at
        // the fight's first millisecond, minutes from any SBA damage. No
        // window may come of it — and a later real art is unaffected.
        let events = vec![
            perform(0, 1),
            sba_damage(180_000, 1),
            perform(181_000, 1),
            sba_damage(188_000, 1),
        ];
        let windows = assemble_chart_windows(&events, 0, 300_000);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (180_000, 188_001));
    }

    #[test]
    fn corroboration_is_per_actor_not_per_fight() {
        // Someone else's SBA damage near a perform does not vouch for it: the
        // phantom perform can land while another member's real art plays.
        let events = vec![
            sba_damage(10_000, 0),
            perform(11_000, 1),
            sba_damage(17_000, 0),
        ];
        let corroborated = corroborated_sba_activations(&events);
        assert!(
            corroborated.is_empty(),
            "slot 1's perform has no slot-1 damage anywhere near it"
        );
        // The damage itself still shades — an art demonstrably played.
        let windows = assemble_chart_windows(&events, 0, 100_000);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (10_000, 17_001));
    }

    #[test]
    fn a_non_sba_hit_is_not_sba_activity() {
        let mut hit = sba_damage(30_000, 5);
        if let Message::DamageEvent(event) = &mut hit.1 {
            event.action_id = ActionType::Normal(42);
        }
        let events = vec![
            sba_damage(20_000, 5),
            perform(21_000, 5),
            sba_damage(26_000, 5),
            // A normal hit 4s later must not stretch the cluster.
            hit,
        ];
        let windows = assemble_chart_windows(&events, 0, 100_000);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (20_000, 26_001));
    }

    #[test]
    fn a_lone_sba_hit_is_a_moment_not_a_window() {
        // One stray SBA-typed hit with nothing around it: a cluster of one
        // draws nothing — the end-exclusive close must not widen it to 1ms.
        let events = vec![sba_damage(30_000, 2)];
        assert_eq!(assemble_chart_windows(&events, 0, 100_000), Vec::new());
    }

    #[test]
    fn break_windows_are_per_enemy_and_close_on_any_other_mode() {
        let events = vec![
            mode(1_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            mode(2_000, 7, EnemyModeEvent::MODE_BREAK),
            mode(2_500, 9, EnemyModeEvent::MODE_BREAK),
            mode(5_000, 7, EnemyModeEvent::MODE_NORMAL),
        ];
        let windows = assemble_chart_windows(&events, 0, 8_000);
        assert_eq!(
            windows,
            vec![
                ChartWindow {
                    kind: ChartWindowKind::Break,
                    start_ms: 2_000,
                    end_ms: 5_000,
                    actor_index: Some(7)
                },
                // Enemy 9 never left Break — its window runs to the fight end.
                ChartWindow {
                    kind: ChartWindowKind::Break,
                    start_ms: 2_500,
                    end_ms: 8_000,
                    actor_index: Some(9)
                },
            ]
        );
    }

    #[test]
    fn an_unclosed_window_runs_to_the_fight_end() {
        let events = vec![link(6_000, true)];
        let windows = assemble_chart_windows(&events, 0, 9_000);
        assert_eq!(windows[0].end_ms, 9_000);
    }

    #[test]
    fn repeats_and_stray_closes_are_tolerated() {
        let events = vec![
            link(500, false), // stray close with nothing open
            link(1_000, true),
            link(1_200, true), // repeat does not restart the window
            link(2_000, false),
        ];
        let windows = assemble_chart_windows(&events, 0, 5_000);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (1_000, 2_000));
    }

    #[test]
    fn timestamps_rebase_onto_the_fight_start() {
        let events = vec![link(10_500, true), link(11_000, false)];
        let windows = assemble_chart_windows(&events, 10_000, 4_000);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (500, 1_000));
    }
}
