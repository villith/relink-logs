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

/// The longest a performer's art is allowed to hold an SBA window open with no
/// SBA damage event closing it: longer than every character's animation, short
/// enough that a lost closing edge cannot shade half the fight. The window
/// closes at whichever comes first.
const SBA_WINDOW_CAP_MS: i64 = 15_000;

/// Walks the raw log and pairs each state's transitions into windows.
///
/// Link and Break come from the hook's latched transition events; the walk
/// still tolerates repeats (a re-sent `active=true` extends nothing) and a
/// window still open at the last event closes at `fight_end_ms` — the state
/// genuinely held to the end of what was recorded.
///
/// SBA windows are DERIVED, not captured: an art's own damage event lands at
/// the END of its animation, so `OnPerformSBA`/`OnContinueSBAChain` opens (or
/// extends) the window and each pending performer is retired by their first
/// `ActionType::SBA` damage event; the window closes when nobody is still
/// performing. Chained arts therefore merge into one window, matching the
/// stretch the boss is actually disabled for. Local-lobby exact; a REMOTE
/// member's perform never emits (the perform hooks are local-only), so online
/// chains can close early — the honest floor, not a claim of full coverage.
pub fn assemble_chart_windows(
    events: &[(i64, Message)],
    start_time: i64,
    fight_end_ms: i64,
) -> Vec<ChartWindow> {
    let mut windows = Vec::new();
    let mut link_open: Option<i64> = None;
    // Per-enemy: the break's opening timestamp, keyed by actor index.
    let mut break_open: HashMap<u32, i64> = HashMap::new();
    // The open SBA window's start, plus who still owes it a damage event and
    // the newest deadline (last perform + cap).
    let mut sba_open: Option<i64> = None;
    let mut sba_pending: HashSet<u32> = HashSet::new();
    let mut sba_deadline: i64 = 0;

    for (ts, message) in events {
        let at = ts - start_time;

        // An expired SBA window closes at its deadline BEFORE this event is
        // considered — a later perform must open a fresh window, not resurrect
        // one whose closing edge was lost.
        if let Some(start) = sba_open {
            if at > sba_deadline {
                windows.push(window(ChartWindowKind::Sba, start, sba_deadline, None));
                sba_open = None;
                sba_pending.clear();
            }
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
            Message::OnPerformSBA(event) => {
                sba_open.get_or_insert(at);
                sba_pending.insert(event.actor_index);
                sba_deadline = at + SBA_WINDOW_CAP_MS;
            }
            Message::OnContinueSBAChain(event) => {
                sba_open.get_or_insert(at);
                sba_pending.insert(event.actor_index);
                sba_deadline = at + SBA_WINDOW_CAP_MS;
            }
            Message::DamageEvent(event) => {
                if sba_open.is_some()
                    && event.action_id == ActionType::SBA
                    && sba_pending.remove(&event.source.parent_index)
                    && sba_pending.is_empty()
                {
                    windows.push(window(
                        ChartWindowKind::Sba,
                        sba_open.take().expect("checked is_some above"),
                        at,
                        None,
                    ));
                }
            }
            _ => {}
        }
    }

    if let Some(start) = link_open {
        windows.push(window(ChartWindowKind::Link, start, fight_end_ms, None));
    }
    if let Some(start) = sba_open {
        windows.push(window(
            ChartWindowKind::Sba,
            start,
            sba_deadline.min(fight_end_ms.max(start)),
            None,
        ));
    }
    for (actor_index, start) in break_open {
        windows.push(window(
            ChartWindowKind::Break,
            start,
            fight_end_ms,
            Some(actor_index),
        ));
    }

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
    fn an_sba_window_opens_on_perform_and_closes_on_the_arts_own_damage() {
        let events = vec![perform(2_000, 5), sba_damage(8_500, 5)];
        let windows = assemble_chart_windows(&events, 0, 20_000);
        assert_eq!(
            windows,
            vec![ChartWindow {
                kind: ChartWindowKind::Sba,
                start_ms: 2_000,
                end_ms: 8_500,
                actor_index: None
            }]
        );
    }

    #[test]
    fn chained_arts_merge_into_one_window_closed_by_the_last_performer() {
        let events = vec![
            perform(2_000, 5),
            chain(3_000, 6),
            sba_damage(8_000, 5),
            sba_damage(14_000, 6),
        ];
        let windows = assemble_chart_windows(&events, 0, 30_000);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (2_000, 14_000));
    }

    #[test]
    fn an_sba_window_with_no_closing_damage_is_capped() {
        // A lost closing edge (remote chain, whiffed capture) must not shade
        // half the fight — and a later perform opens a FRESH window rather
        // than resurrecting the expired one.
        let events = vec![perform(2_000, 5), perform(40_000, 6), sba_damage(46_000, 6)];
        let windows = assemble_chart_windows(&events, 0, 60_000);
        assert_eq!(windows.len(), 2);
        assert_eq!(
            (windows[0].start_ms, windows[0].end_ms),
            (2_000, 2_000 + SBA_WINDOW_CAP_MS)
        );
        assert_eq!((windows[1].start_ms, windows[1].end_ms), (40_000, 46_000));
    }

    #[test]
    fn a_non_sba_hit_from_the_performer_does_not_close_the_window() {
        let mut hit = sba_damage(3_000, 5);
        if let Message::DamageEvent(event) = &mut hit.1 {
            event.action_id = ActionType::Normal(42);
        }
        let events = vec![perform(2_000, 5), hit, sba_damage(9_000, 5)];
        let windows = assemble_chart_windows(&events, 0, 20_000);
        assert_eq!((windows[0].start_ms, windows[0].end_ms), (2_000, 9_000));
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
