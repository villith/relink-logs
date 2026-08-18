//! Chart windows: spans of fight time during which a party-wide (or
//! per-enemy) battle state held — Link Time, an SBA performance, an enemy's
//! Overdrive or Break — assembled from the transition events the hook
//! records. The analysis chart shades them behind its series, the way the
//! aura filter's bands already shade exclusions.
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
    /// An enemy sitting in Overdrive (heightened, pre-Break).
    Overdrive,
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
    /// The enemy's actor index for `Overdrive`/`Break` windows (so two
    /// bosses' state stays distinguishable in a tooltip); `None` for the
    /// party-wide kinds.
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

/// One Skybound Art a fight contains, as the response should report it.
pub enum SbaActivation {
    /// The raw-log index of the activation event the hook did record.
    Recorded(usize),
    /// An art the hook recorded no activation event for: its performer, and
    /// the timestamp of the art's first SBA hit.
    Derived { at: i64, actor_index: u32 },
}

/// Every art the fight contains, recovered from its DAMAGE rather than from
/// the activation events alone.
///
/// The hook does not record an activation for every art. Its surviving
/// producer walks the four party slots' gauges and calls an art when it
/// SAMPLES a slot at exactly zero, and it samples only from inside the
/// gauge-update detour — so a performer whose bar has already begun refilling
/// by the next update is never seen at zero. Measured on log 2698: one
/// activation recorded across a four-art chain, the other three first sampled
/// at 2.7, 0.9 and 2.8 out of a full 800.
///
/// An art's damage is always recorded, so one per-performer damage cluster
/// (the same [`SBA_CLUSTER_GAP_MS`] the windows cluster by — one actor cannot
/// refill a bar inside it) is one art. A corroborated activation event lying
/// within the corroboration window of that cluster IS that art's, and is kept
/// verbatim so the recorded timestamp and the perform/chain distinction
/// survive; an art with none gets one derived at its first hit. An activation
/// no cluster claims is the phantom [`corroborated_sba_activations`] already
/// describes, and is dropped.
pub fn sba_activations(events: &[(i64, Message)]) -> Vec<SbaActivation> {
    let corroborated = corroborated_sba_activations(events);
    let recorded: Vec<(usize, i64, u32)> = events
        .iter()
        .enumerate()
        .filter_map(|(index, (ts, message))| {
            if !corroborated.contains(&index) {
                return None;
            }
            match message {
                Message::OnPerformSBA(event) => Some((index, *ts, event.actor_index)),
                Message::OnContinueSBAChain(event) => Some((index, *ts, event.actor_index)),
                _ => None,
            }
        })
        .collect();

    // Per-performer SBA damage clusters, as (performer, first hit, last hit).
    let mut clusters: Vec<(u32, i64, i64)> = Vec::new();
    let mut open: HashMap<u32, usize> = HashMap::new();
    for (ts, message) in events {
        let Message::DamageEvent(event) = message else {
            continue;
        };
        if event.action_id != ActionType::SBA {
            continue;
        }
        let actor = event.source.parent_index;
        match open.get(&actor) {
            Some(&cluster) if ts - clusters[cluster].2 <= SBA_CLUSTER_GAP_MS => {
                clusters[cluster].2 = *ts
            }
            _ => {
                open.insert(actor, clusters.len());
                clusters.push((actor, *ts, *ts));
            }
        }
    }

    let mut claimed: HashSet<usize> = HashSet::new();
    let mut activations: Vec<(i64, SbaActivation)> = Vec::with_capacity(clusters.len());
    for (actor_index, first, last) in clusters {
        let recorded = recorded.iter().find(|(index, ts, actor)| {
            *actor == actor_index
                && !claimed.contains(index)
                && *ts >= first - SBA_CORROBORATION_BEFORE_MS
                && *ts <= last + SBA_CORROBORATION_AFTER_MS
        });
        match recorded {
            Some(&(index, ts, _)) => {
                claimed.insert(index);
                activations.push((ts, SbaActivation::Recorded(index)));
            }
            None => activations.push((
                first,
                SbaActivation::Derived {
                    at: first,
                    actor_index,
                },
            )),
        }
    }

    activations.sort_by_key(|(ts, _)| *ts);
    activations.into_iter().map(|(_, art)| art).collect()
}

/// Walks the raw log and pairs each state's transitions into windows.
///
/// Link, Overdrive and Break come from the hook's latched transition events;
/// the walk still tolerates repeats (a re-sent `active=true`, or a mode event
/// repeating the mode already open, extends nothing) and a window still open
/// at the last event closes at `fight_end_ms` — the state genuinely held to
/// the end of what was recorded.
///
/// Overdrive and Break are mutually exclusive per enemy — an `EnemyMode`
/// event names the ONE mode that enemy is now in, so a transition between
/// them closes whichever was open and opens the other in the same step; a
/// transition to Normal closes whichever was open and opens neither.
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
    // Per-enemy: the overdrive's opening timestamp, keyed by actor index.
    let mut overdrive_open: HashMap<u32, i64> = HashMap::new();
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
                let actor = event.actor_index;
                // An EnemyMode event names the ONE mode this enemy is now
                // in, so entering one of Overdrive/Break closes the other if
                // it was open (a direct 2->1 or 1->2 transition) before
                // opening the new one; entering Normal closes whichever was
                // open and opens neither. `or_insert` on the still-open side
                // is what makes a repeated mode extend nothing.
                if event.mode != protocol::EnemyModeEvent::MODE_OVERDRIVE {
                    if let Some(start) = overdrive_open.remove(&actor) {
                        windows.push(window(ChartWindowKind::Overdrive, start, at, Some(actor)));
                    }
                }
                if event.mode != protocol::EnemyModeEvent::MODE_BREAK {
                    if let Some(start) = break_open.remove(&actor) {
                        windows.push(window(ChartWindowKind::Break, start, at, Some(actor)));
                    }
                }
                if event.mode == protocol::EnemyModeEvent::MODE_OVERDRIVE {
                    overdrive_open.entry(actor).or_insert(at);
                } else if event.mode == protocol::EnemyModeEvent::MODE_BREAK {
                    break_open.entry(actor).or_insert(at);
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
    for (actor_index, start) in overdrive_open {
        windows.push(window(
            ChartWindowKind::Overdrive,
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
                record_snapshot: None,
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

    /// `(timestamp, performer)` per activation, whichever way it was recovered
    /// — what the response ends up carrying.
    fn activations(events: &[(i64, Message)]) -> Vec<(i64, u32)> {
        sba_activations(events)
            .into_iter()
            .map(|activation| match activation {
                SbaActivation::Recorded(index) => match &events[index].1 {
                    Message::OnPerformSBA(event) => (events[index].0, event.actor_index),
                    Message::OnContinueSBAChain(event) => (events[index].0, event.actor_index),
                    other => panic!("not an activation: {other:?}"),
                },
                SbaActivation::Derived { at, actor_index } => (at, actor_index),
            })
            .collect()
    }

    #[test]
    fn an_art_the_hook_recorded_no_activation_for_still_reports_one() {
        // The 2.0.4 shape (log 2698): four arts, one recorded activation. The
        // three the gauge poll never sampled at zero are recovered from their
        // damage, each at the hit its art opened with.
        let events = vec![
            sba_damage(221_870, 3),
            sba_damage(226_153, 3),
            perform(229_087, 0),
            sba_damage(229_503, 0),
            sba_damage(234_170, 0),
            sba_damage(236_870, 1),
            sba_damage(238_604, 1),
            sba_damage(241_537, 2),
            sba_damage(244_953, 2),
        ];
        assert_eq!(
            activations(&events),
            vec![(221_870, 3), (229_087, 0), (236_870, 1), (241_537, 2)]
        );
    }

    #[test]
    fn a_recorded_activation_is_kept_rather_than_derived_beside() {
        // The perform lands after its art's opening hits (measured up to ~2.5s
        // either way), and is still that art's — one activation, at the
        // recorded time, not one per source.
        let events = vec![
            sba_damage(235_241, 3),
            sba_damage(238_124, 3),
            chain(238_425, 3),
            sba_damage(239_174, 3),
        ];
        assert_eq!(activations(&events), vec![(238_425, 3)]);
    }

    #[test]
    fn two_activations_recorded_for_one_art_report_it_once() {
        let events = vec![
            perform(20_000, 0),
            sba_damage(20_400, 0),
            chain(21_000, 0),
            sba_damage(27_000, 0),
        ];
        assert_eq!(activations(&events), vec![(20_000, 0)]);
    }

    #[test]
    fn a_phantom_activation_reports_no_art() {
        // The Repeat Quest boundary perform, and the real art minutes later.
        let events = vec![
            perform(0, 1),
            sba_damage(180_000, 1),
            perform(181_000, 1),
            sba_damage(188_000, 1),
        ];
        assert_eq!(activations(&events), vec![(181_000, 1)]);
    }

    #[test]
    fn one_actor_arting_twice_reports_two() {
        let events = vec![
            sba_damage(20_000, 0),
            sba_damage(27_000, 0),
            sba_damage(160_000, 0),
            sba_damage(167_000, 0),
        ];
        assert_eq!(activations(&events), vec![(20_000, 0), (160_000, 0)]);
    }

    #[test]
    fn an_activation_is_not_claimed_by_another_actors_art() {
        let events = vec![
            sba_damage(10_000, 0),
            perform(11_000, 1),
            sba_damage(17_000, 0),
        ];
        assert_eq!(activations(&events), vec![(10_000, 0)]);
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
                // Enemy 7's own Overdrive phase, before it broke — this
                // fixture predates the Overdrive kind and originally only
                // asserted the Break window below; now that Overdrive is
                // tracked too, the 1->2 hand-off at 2_000 genuinely produces
                // both windows.
                ChartWindow {
                    kind: ChartWindowKind::Overdrive,
                    start_ms: 1_000,
                    end_ms: 2_000,
                    actor_index: Some(7)
                },
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
    fn overdrive_and_break_are_separate_windows_that_hand_off_directly() {
        // One enemy's full arc: Normal -> Overdrive -> Break -> Normal. The
        // 1->2 transition at 2_000 must close the Overdrive window and open
        // Break in the same step — not merge the two kinds into one span.
        let events = vec![
            mode(1_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            mode(2_000, 7, EnemyModeEvent::MODE_BREAK),
            mode(5_000, 7, EnemyModeEvent::MODE_NORMAL),
        ];
        let windows = assemble_chart_windows(&events, 0, 8_000);
        assert_eq!(
            windows,
            vec![
                ChartWindow {
                    kind: ChartWindowKind::Overdrive,
                    start_ms: 1_000,
                    end_ms: 2_000,
                    actor_index: Some(7)
                },
                ChartWindow {
                    kind: ChartWindowKind::Break,
                    start_ms: 2_000,
                    end_ms: 5_000,
                    actor_index: Some(7)
                },
            ]
        );
    }

    #[test]
    fn a_repeated_mode_extends_nothing() {
        // Pins the doc claim directly: two OVERDRIVE events in a row for the
        // same actor must not open a second window or move the start — only
        // the eventual transition to NORMAL closes the one window.
        let events = vec![
            mode(1_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            mode(2_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            mode(5_000, 7, EnemyModeEvent::MODE_NORMAL),
        ];
        let windows = assemble_chart_windows(&events, 0, 8_000);
        assert_eq!(
            windows,
            vec![ChartWindow {
                kind: ChartWindowKind::Overdrive,
                start_ms: 1_000,
                end_ms: 5_000,
                actor_index: Some(7)
            }]
        );
    }

    #[test]
    fn break_to_overdrive_closes_break_and_opens_overdrive_at_the_same_step() {
        // The mirror of `overdrive_and_break_are_separate_windows_that_hand_off_directly`:
        // the game re-enters Overdrive after a Break in real fights, so the
        // 2->1 hand-off must close Break and open Overdrive in the same step,
        // not merge the two kinds into one span.
        let events = vec![
            mode(1_000, 7, EnemyModeEvent::MODE_BREAK),
            mode(2_000, 7, EnemyModeEvent::MODE_OVERDRIVE),
            mode(5_000, 7, EnemyModeEvent::MODE_NORMAL),
        ];
        let windows = assemble_chart_windows(&events, 0, 8_000);
        assert_eq!(
            windows,
            vec![
                ChartWindow {
                    kind: ChartWindowKind::Break,
                    start_ms: 1_000,
                    end_ms: 2_000,
                    actor_index: Some(7)
                },
                ChartWindow {
                    kind: ChartWindowKind::Overdrive,
                    start_ms: 2_000,
                    end_ms: 5_000,
                    actor_index: Some(7)
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
