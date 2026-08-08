//! Names gauge the hook could not name, by joining a finished log against
//! itself.
//!
//! WHY THIS EXISTS. A gauge rise is captioned by the hook parking a cause on
//! the thread the game's gauge update runs on (see `src-hook`'s grant sites).
//! That only works where the gauge math runs locally. Online, a remote party
//! member's gauge is SYNCED — no grant frame executes on this machine, so the
//! only record of their gauge is the four-slot poll, which reports a level and
//! cannot say what raised it. Their whole bar therefore lands in the SBA tab's
//! unattributed remainder, which is the state this module improves on.
//!
//! WHAT IT IS ALLOWED TO CONCLUDE. Every verdict here is a correlation, not a
//! measurement, so:
//!   * it only ever emits `Inferred*` causes — a deduction must never be
//!     indistinguishable from something the hook actually read;
//!   * it names a rise only when the evidence is UNAMBIGUOUS, and drops it
//!     otherwise. An unnamed rise costs nothing (the remainder already holds
//!     it); a wrongly named one corrupts a breakdown row;
//!   * it never opens a breakdown row. A move verdict is keyed off a damage
//!     event that exists, so the row it lands in was opened by a real hit —
//!     the same invariant `PlayerState::add_sba_gain` enforces.
//!
//! It reads an event slice and nothing else of the parser's state, so a
//! reopened log and a just-finished fight attribute identically. It runs on
//! reparse rather than live because it needs rises and hits on both sides of
//! each other in time.

use std::collections::HashMap;

use protocol::{ActionType, Message, SbaGainCause};

use super::is_damage_taken_event;

/// The flat SBA-chain contribution: 10% of the 1000-unit bar.
///
/// Recognised by exact value, which is only safe because it is paired with the
/// rule ordering below — a value alone never names a mechanic, and other flat
/// awards share this size.
const CHAIN_GRANT: f64 = 100.0;

/// The same contribution when the player who landed the SBA runs an Alpha
/// sigil trait at Lv. 30+. Accepted as a chain-grant value; never used to
/// distinguish anything.
const CHAIN_GRANT_ALPHA: f64 = 130.0;

/// How close a value must be to a flat grant to be read as one. Gauge arrives
/// as f32 through two conversions, so this is float slop, not tolerance.
const VALUE_EPSILON: f64 = 0.01;

/// Rises smaller than this are not worth a verdict — poll quantisation and
/// float slop live down here, and naming noise only makes a breakdown wrong in
/// small increments instead of large ones.
const MIN_RESIDUAL: f64 = 0.5;

/// The correlation windows every rule decides at.
///
/// A struct rather than loose constants so a future scorer can sweep them;
/// `Default` IS the shipped configuration and is the only thing the parser
/// uses.
#[derive(Debug, Clone, Copy)]
pub(super) struct Windows {
    /// How late a hook-read gain may arrive and still belong to the poll tick
    /// it precedes.
    ///
    /// Only a tolerance, not the matching rule. A poll rise reports everything
    /// the gauge did since that slot's PREVIOUS tick, so the gains it covers
    /// are the ones in that interval — which is what the residual walk pairs
    /// them by. This just admits a gain that crossed the pipe a moment behind
    /// its own tick.
    pub poll_lag_ms: i64,
    /// How far a rise may sit from the damage record that explains it.
    pub move_ms: i64,
    /// How far a rise may sit from an incoming hit for the damage-taken rule.
    /// Wider than `move_ms`: the gauge for a hit taken is granted on the
    /// victim's side of a hit the host resolved, so it trails further.
    pub taken_ms: i64,
}

impl Default for Windows {
    fn default() -> Self {
        Self {
            poll_lag_ms: 16,
            move_ms: 64,
            taken_ms: 250,
        }
    }
}

/// One verdict: gauge this module decided it can name.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct InferredGain {
    /// When the rise happened, so the SBA chart can bucket a verdict exactly
    /// where the poll saw it. The derived-state fold ignores this.
    pub at: i64,
    pub actor_index: u32,
    pub cause: SbaGainCause,
    pub amount: f64,
}

/// Which rule produced a verdict. Carried for tests and future scoring — the
/// cause alone cannot say, because two rules can reach the same cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Rule {
    /// A flat chain grant, recognised by its exact value.
    FlatGrant,
    /// Correlated against exactly one of the actor's own actions.
    Move,
    /// Correlated against a hit the actor received.
    DamageTaken,
}

/// What one player's log looks like to the rules.
#[derive(Default)]
struct PlayerEvidence {
    /// Poll rises: (timestamp, gauge added).
    rises: Vec<(i64, f64)>,
    /// Hook-read gains: (timestamp, amount). These are already captioned; they
    /// exist here only to be SUBTRACTED from the rises they explain.
    read_gains: Vec<(i64, f64)>,
    /// The player's own damaging hits: (timestamp, raw classified action).
    hits: Vec<(i64, ActionType)>,
    /// Timestamps of hits the player received.
    taken: Vec<i64>,
}

/// Collects, per player, the evidence the rules join across.
///
/// `admitted` is the reparse's own event-admission test, passed in rather than
/// re-implemented, so inference sees exactly the events the derived state was
/// built from. If it saw more, inferred gauge could exceed the polled total it
/// is meant to be splitting.
fn gather(
    events: &[(i64, Message)],
    admitted: &dyn Fn(i64) -> bool,
) -> HashMap<u32, PlayerEvidence> {
    let mut by_player: HashMap<u32, PlayerEvidence> = HashMap::new();

    for (timestamp, event) in events {
        if !admitted(*timestamp) {
            continue;
        }
        match event {
            Message::OnUpdateSBA(update) => {
                let added = update.sba_added as f64;
                if added > 0.0 {
                    by_player
                        .entry(update.actor_index)
                        .or_default()
                        .rises
                        .push((*timestamp, added));
                }
            }
            Message::SbaGain(gain) => {
                by_player
                    .entry(gain.actor_index)
                    .or_default()
                    .read_gains
                    .push((*timestamp, gain.amount as f64));
            }
            Message::DamageEvent(damage) => {
                if is_damage_taken_event(damage) {
                    // The victim is the party member; their gauge is what rose.
                    by_player
                        .entry(damage.target.parent_index)
                        .or_default()
                        .taken
                        .push(*timestamp);
                } else {
                    by_player
                        .entry(damage.source.parent_index)
                        .or_default()
                        .hits
                        .push((*timestamp, damage.action_id));
                }
            }
            _ => {}
        }
    }

    by_player
}

/// The part of each poll rise that no hook-read gain already accounts for.
///
/// The two are views of one accrual, not independent facts: a rise reports
/// everything the gauge did since that slot's previous tick, and the gains the
/// hook read in that same interval are the captioned part of it. So the walk
/// pairs them by interval — each gain is consumed by the first tick at or after
/// it — rather than by proximity. Matching on proximity alone is what lets a
/// gain read 20 ms before its own tick go uncounted and the whole rise then get
/// named a second time, which double-counts a locally simulated player's bar.
///
/// A gain larger than the tick it lands in carries its surplus forward, because
/// the overflow belongs to the same accrual and the next tick is where the poll
/// reports it. Gains after the last tick are simply never spent.
///
/// Both inputs are in log order, which the event walk guarantees.
fn residuals(rises: &[(i64, f64)], read_gains: &[(i64, f64)], lag: i64) -> Vec<(i64, f64)> {
    let mut out = Vec::with_capacity(rises.len());
    let mut next_gain = 0;
    let mut credit = 0.0;

    for (at, amount) in rises {
        while next_gain < read_gains.len() && read_gains[next_gain].0 <= at + lag {
            credit += read_gains[next_gain].1;
            next_gain += 1;
        }
        let explained = credit.min(*amount);
        credit -= explained;
        out.push((*at, amount - explained));
    }

    out
}

/// The one action that explains a rise, if exactly one does.
///
/// Ambiguity is fatal by design: with two distinct actions in the window there
/// is no evidence saying which paid, and picking either would put real gauge on
/// the wrong row. Repeats of the SAME action are not ambiguous — they agree.
fn sole_action_near(hits: &[(i64, ActionType)], at: i64, window: i64) -> Option<ActionType> {
    let mut found: Option<ActionType> = None;

    for (hit_at, action) in hits {
        if (hit_at - at).abs() > window {
            continue;
        }
        match found {
            None => found = Some(*action),
            Some(existing) if existing == *action => {}
            Some(_) => return None,
        }
    }

    found
}

fn is_flat_grant(amount: f64) -> bool {
    (amount - CHAIN_GRANT).abs() < VALUE_EPSILON
        || (amount - CHAIN_GRANT_ALPHA).abs() < VALUE_EPSILON
}

/// Names what it can of the gauge in `events`, at the shipped windows.
pub(super) fn infer(
    events: &[(i64, Message)],
    admitted: &dyn Fn(i64) -> bool,
) -> Vec<InferredGain> {
    infer_tagged(events, admitted, Windows::default())
        .into_iter()
        .map(|(gain, _)| gain)
        .collect()
}

/// [`infer`], plus which rule decided each verdict and with the windows
/// overridable. Tests and future scoring tooling use this; the parser takes the
/// projection above so there is exactly one shipped configuration.
pub(super) fn infer_tagged(
    events: &[(i64, Message)],
    admitted: &dyn Fn(i64) -> bool,
    windows: Windows,
) -> Vec<(InferredGain, Rule)> {
    let by_player = gather(events, admitted);
    let mut verdicts = Vec::new();

    // Sorted so a log's verdicts do not depend on HashMap iteration order —
    // the parser folds these into rows and a stable order keeps reparses
    // byte-identical.
    let mut players: Vec<_> = by_player.into_iter().collect();
    players.sort_by_key(|(index, _)| *index);

    for (actor_index, evidence) in players {
        for (at, residual) in residuals(&evidence.rises, &evidence.read_gains, windows.poll_lag_ms)
        {
            if residual < MIN_RESIDUAL {
                continue;
            }

            // Rule order is a precision order, not a preference. The flat grant
            // is an exact value match and goes first: a chain contribution that
            // happens to land beside the recipient's own swing would otherwise
            // be read as that swing's output and inflate the move's row.
            let (cause, rule) = if is_flat_grant(residual) {
                (SbaGainCause::InferredChainGrant, Rule::FlatGrant)
            } else if let Some(action) = sole_action_near(&evidence.hits, at, windows.move_ms) {
                (SbaGainCause::Inferred(action), Rule::Move)
            } else if evidence
                .taken
                .iter()
                .any(|taken_at| (taken_at - at).abs() <= windows.taken_ms)
            {
                (SbaGainCause::InferredDamageTaken, Rule::DamageTaken)
            } else {
                // Nothing explains it. The remainder keeps it, which is the
                // honest outcome — this module's job is to shrink that band
                // only where it can say why.
                continue;
            };

            verdicts.push((
                InferredGain {
                    at,
                    actor_index,
                    cause,
                    amount: residual,
                },
                rule,
            ));
        }
    }

    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Actor, DamageEvent, OnUpdateSBAEvent, SbaGainEvent};

    const PLAYER: u32 = 0xF000_0000;
    const OTHER: u32 = 0xF000_0001;
    const ENEMY: u32 = 0x99;

    fn always(_: i64) -> bool {
        true
    }

    fn actor(index: u32) -> Actor {
        Actor {
            index,
            actor_type: 1,
            parent_index: index,
            parent_actor_type: 1,
        }
    }

    fn hit(source: u32, target: u32, action: u32) -> Message {
        Message::DamageEvent(DamageEvent {
            source: actor(source),
            target: actor(target),
            damage: 100,
            flags: 0,
            action_id: ActionType::Normal(action),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        })
    }

    fn rise(actor_index: u32, added: f32) -> Message {
        Message::OnUpdateSBA(OnUpdateSBAEvent {
            actor_index,
            sba_value: added,
            sba_added: added,
        })
    }

    fn read_gain(actor_index: u32, amount: f32) -> Message {
        Message::SbaGain(SbaGainEvent {
            actor_index,
            action_id: 0,
            amount,
            cause: Some(SbaGainCause::Skill(ActionType::Normal(1))),
        })
    }

    fn causes(events: &[(i64, Message)]) -> Vec<SbaGainCause> {
        infer(events, &always)
            .into_iter()
            .map(|gain| gain.cause)
            .collect()
    }

    /// The headline case: a remote member's rise beside exactly one of their
    /// own hits is named as that action.
    #[test]
    fn a_rise_beside_one_action_is_attributed_to_it() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];

        assert_eq!(
            infer(&events, &always),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 12.5,
            }]
        );
    }

    /// Two different actions in the window is not evidence for either, so the
    /// rise stays unnamed rather than landing on a coin-flip row.
    #[test]
    fn two_actions_in_the_window_leave_the_rise_unnamed() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, hit(PLAYER, ENEMY, 77)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert!(infer(&events, &always).is_empty());
    }

    /// Repeats of the same action agree with each other — a multi-hit move is
    /// not ambiguous.
    #[test]
    fn repeats_of_one_action_still_attribute() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// Another player's hit is not evidence about this player's gauge.
    #[test]
    fn another_players_hit_does_not_explain_this_players_rise() {
        let events = vec![(100, hit(OTHER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always).is_empty());
    }

    /// A hit outside the window explains nothing.
    #[test]
    fn a_distant_hit_does_not_attribute() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (900, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always).is_empty());
    }

    /// The flat chain grant is recognised by value, and beats the move rule —
    /// otherwise a chain contribution landing beside the recipient's own swing
    /// would inflate that swing's row.
    #[test]
    fn a_flat_chain_grant_outranks_a_coincident_action() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 100.0))];

        assert_eq!(causes(&events), vec![SbaGainCause::InferredChainGrant]);
    }

    /// The Alpha-trait chain value counts as the same mechanic.
    #[test]
    fn the_alpha_chain_value_is_also_a_flat_grant() {
        let events = vec![(104, rise(PLAYER, 130.0))];

        assert_eq!(causes(&events), vec![SbaGainCause::InferredChainGrant]);
    }

    /// Gauge from taking a hit, with no action of the player's own to explain it.
    #[test]
    fn a_rise_after_an_incoming_hit_is_damage_taken() {
        let events = vec![(100, hit(ENEMY, PLAYER, 5)), (150, rise(PLAYER, 8.4))];

        assert_eq!(causes(&events), vec![SbaGainCause::InferredDamageTaken]);
    }

    /// The player's own action outranks an incoming hit: the move rule is the
    /// tighter window and the more specific claim.
    #[test]
    fn an_own_action_outranks_a_coincident_incoming_hit() {
        let events = vec![
            (100, hit(ENEMY, PLAYER, 5)),
            (102, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// THE double-count guard: a rise the hook already captioned is not
    /// re-attributed. Without this the local player's gauge would be counted
    /// once by the hook and again by inference.
    #[test]
    fn a_rise_a_read_gain_explains_is_not_inferred() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 12.5)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert!(infer(&events, &always).is_empty());
    }

    /// Only the UNEXPLAINED part of a partly-read rise is inferred — the poll
    /// coalesces everything since its last tick, so one rise can legitimately
    /// cover a read gain plus gauge from somewhere the hook could not see.
    #[test]
    fn only_the_unexplained_part_of_a_rise_is_inferred() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 10.0)),
            (104, rise(PLAYER, 30.0)),
        ];

        assert_eq!(
            infer(&events, &always),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 20.0,
            }]
        );
    }

    /// One read gain cannot cancel two rises: it is spent by the first.
    #[test]
    fn a_read_gain_is_spent_by_the_rise_it_explains() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 12.5)),
            (104, rise(PLAYER, 12.5)),
            (106, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            infer(&events, &always),
            vec![InferredGain {
                at: 106,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 12.5,
            }]
        );
    }

    /// A read gain is claimed by the next tick however far away it is: the poll
    /// reports everything since that slot's previous tick, so a long gap means
    /// one rise legitimately covers an old gain. Pairing by proximity instead
    /// would leave the gain unspent and name the whole rise a second time.
    #[test]
    fn a_read_gain_is_claimed_by_the_next_tick_however_distant() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 12.5)),
            (900, hit(PLAYER, ENEMY, 42)),
            (904, rise(PLAYER, 12.5)),
        ];

        assert!(infer(&events, &always).is_empty());
    }

    /// A read gain AFTER the last tick is never spent, so it cannot cancel
    /// anything that came before it.
    #[test]
    fn a_read_gain_after_the_last_tick_cancels_nothing() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
            (900, read_gain(PLAYER, 12.5)),
        ];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// A gain bigger than the tick it lands in carries its surplus to the next
    /// one — the overflow is the same accrual, reported a tick later.
    #[test]
    fn a_read_gain_larger_than_its_tick_carries_forward() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 30.0)),
            (104, rise(PLAYER, 10.0)),
            (130, rise(PLAYER, 25.0)),
        ];

        // 30 read against 10 then 25 leaves 5 unexplained on the second tick.
        assert_eq!(
            infer(&events, &always),
            vec![InferredGain {
                at: 130,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 5.0,
            }]
        );
    }

    /// Noise-sized residues are not worth a verdict.
    #[test]
    fn a_tiny_residual_is_left_alone() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 0.2))];

        assert!(infer(&events, &always).is_empty());
    }

    /// Events the reparse excluded must be invisible here too, or inferred
    /// gauge would exceed the polled total it is splitting.
    #[test]
    fn excluded_events_are_not_evidence() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];
        let admitted = |timestamp: i64| timestamp >= 200;

        assert!(infer(&events, &admitted).is_empty());
    }

    /// Verdicts come out in a stable order regardless of map iteration.
    #[test]
    fn verdicts_are_ordered_by_player() {
        let events = vec![
            (100, hit(OTHER, ENEMY, 7)),
            (104, rise(OTHER, 12.5)),
            (106, hit(PLAYER, ENEMY, 42)),
            (108, rise(PLAYER, 12.5)),
        ];

        let actors: Vec<_> = infer(&events, &always)
            .into_iter()
            .map(|gain| gain.actor_index)
            .collect();
        assert_eq!(actors, vec![PLAYER, OTHER]);
    }

    /// Every verdict is marked as deduced, which is what keeps it separable
    /// from anything the hook read.
    #[test]
    fn every_verdict_is_flagged_inferred() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
            (200, rise(PLAYER, 100.0)),
            (300, hit(ENEMY, PLAYER, 5)),
            (350, rise(PLAYER, 8.4)),
        ];

        let verdicts = infer(&events, &always);
        assert_eq!(verdicts.len(), 3);
        assert!(verdicts.iter().all(|gain| gain.cause.is_inferred()));
    }

    /// The rules each verdict came from, so a change of rule ordering shows up
    /// as a test failure rather than a silent re-attribution.
    #[test]
    fn rules_are_reported_per_verdict() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
            (200, rise(PLAYER, 100.0)),
            (300, hit(ENEMY, PLAYER, 5)),
            (350, rise(PLAYER, 8.4)),
        ];

        let rules: Vec<_> = infer_tagged(&events, &always, Windows::default())
            .into_iter()
            .map(|(_, rule)| rule)
            .collect();
        assert_eq!(rules, vec![Rule::Move, Rule::FlatGrant, Rule::DamageTaken]);
    }
}
