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
//! HOW A RISE IS SPLIT. The game grants `spArtsRate × K` gauge per damaging
//! hit, where `spArtsRate` is a per-action constant authored in the game's
//! data files (the `sba_weights` table) and `K` is a per-fight scale. A rise
//! is therefore split across the hits it reports in proportion to their
//! authored weights — `K` cancels in the ratio, so the split needs no
//! knowledge of the fight's scale. An action the table does not cover weighs
//! the game's own default of 1.0; hit kinds the corpus proves grant nothing
//! (echoes, DoT ticks, SBA hits) weigh zero and cannot dilute the rest.
//!
//! WHAT IT IS ALLOWED TO CONCLUDE. Every verdict here is a deduction, not a
//! measurement, so:
//!   * it only ever emits `Inferred*` causes — a deduction must never be
//!     indistinguishable from something the hook actually read;
//!   * a share verdict distributes ONLY the polled residual — inference can
//!     misplace gauge between a player's own rows, never invent it;
//!   * it never opens a breakdown row. A share verdict is keyed off a damage
//!     event that exists, so the row it lands in was opened by a real hit —
//!     the same invariant `PlayerState::add_sba_gain` enforces.
//!
//! It reads an event slice plus the party roster's character aliases (see
//! [`character_aliases`]) and nothing else of the parser's state, so a
//! reopened log and a just-finished fight attribute identically. It runs on
//! reparse rather than live because it needs rises and hits on both sides of
//! each other in time.

use std::collections::HashMap;

use protocol::{ActionType, Message, SbaGainCause};

use super::{is_damage_taken_event, sba_weights};
use crate::parser::constants::CharacterType;

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
    /// How late a hit may log after the tick that reports its gauge — network
    /// replay can order a remote's damage event behind the synced rise it paid
    /// into.
    pub move_ms: i64,
    /// How stale a hit may be and still pay into a tick. A grant surfaces at
    /// the first poll emission after its sync lands (~one rise cadence, median
    /// 251 ms measured), so a hit much older than that with no rise in between
    /// provably granted nothing — counting it would put someone else's gauge
    /// on its row.
    pub move_lookback_ms: i64,
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
            move_lookback_ms: 500,
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
    /// Split across the actor's own hits by their authored gauge weights
    /// (see `sba_weights`).
    Share,
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

/// Every actor key a party member answers to, mapped to who they are.
///
/// Identity lives in the encounter's party roster, NOT the event log — the
/// live path folds load/identity events into `player_data` without storing
/// them — and the roster's `actor_index` is the raw entity index while rises
/// and player-keyed hits arrive under `player_slot_key(slot)`. Both keys map
/// here so the evidence walk can look a player up by whichever key the event
/// carried.
pub(super) fn character_aliases(
    player_data: &[Option<super::PlayerData>; 4],
) -> HashMap<u32, CharacterType> {
    let mut aliases = HashMap::new();
    for (slot, data) in player_data.iter().enumerate() {
        if let Some(data) = data {
            aliases.insert(data.actor_index, data.character_type);
            aliases.insert(protocol::player_slot_key(slot as u8), data.character_type);
        }
    }
    aliases
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

/// Walks a player's hits tick by tick, handing each tick the weighted actions
/// that pay into it.
///
/// A hit belongs to the FIRST tick at or after it (within `move_ms` of lag —
/// network replay can log a remote's hit just behind the rise it paid into),
/// mirroring how [`residuals`] spends read gains: its grant surfaced at the
/// first poll emission after its sync landed, and counting it again for a
/// later tick would name new gauge after the hit's own rise already did. A hit
/// staler than `move_lookback_ms` is discarded instead — had it granted, a
/// rise would have surfaced within a poll cadence, so whatever rose now is not
/// it.
struct HitShares<'a> {
    hits: &'a [(i64, ActionType)],
    weights: Option<&'a sba_weights::CharacterWeights>,
    next: usize,
}

impl<'a> HitShares<'a> {
    fn new(hits: &'a [(i64, ActionType)], character: Option<CharacterType>) -> Self {
        Self {
            hits,
            weights: character.and_then(sba_weights::for_character),
            next: 0,
        }
    }

    /// The actions paying into the tick at `at`, each with its summed weight
    /// (in first-hit order, so verdicts are log-ordered), plus the tick's
    /// total. Zero-weight hits are consumed but contribute nothing.
    fn for_tick(&mut self, at: i64, windows: &Windows) -> (Vec<(ActionType, f64)>, f64) {
        let mut shares: Vec<(ActionType, f64)> = Vec::new();
        let mut total = 0.0;

        while self.next < self.hits.len() && self.hits[self.next].0 <= at + windows.move_ms {
            let (hit_at, action) = self.hits[self.next];
            self.next += 1;
            if hit_at < at - windows.move_lookback_ms {
                continue;
            }
            let weight = match sba_weights::hit_weight(self.weights, action) {
                Some(weight) => weight,
                None => {
                    // Worth a line, not a verdict change: an unknown action is
                    // how the weight table learns it has a hole.
                    log::debug!("sba_weights has no entry for {action:?}; assuming 1.0");
                    sba_weights::DEFAULT_ACTION_WEIGHT
                }
            };
            if weight <= 0.0 {
                continue;
            }
            total += weight;
            match shares.iter_mut().find(|(existing, _)| *existing == action) {
                Some((_, sum)) => *sum += weight,
                None => shares.push((action, weight)),
            }
        }

        (shares, total)
    }
}

fn is_flat_grant(amount: f64) -> bool {
    (amount - CHAIN_GRANT).abs() < VALUE_EPSILON
        || (amount - CHAIN_GRANT_ALPHA).abs() < VALUE_EPSILON
}

/// Names what it can of the gauge in `events`, at the shipped windows.
/// `characters` is the alias map from [`character_aliases`] — who each actor
/// key belongs to, which selects the weight table their hits are priced by.
pub(super) fn infer(
    events: &[(i64, Message)],
    admitted: &dyn Fn(i64) -> bool,
    characters: &HashMap<u32, CharacterType>,
) -> Vec<InferredGain> {
    infer_tagged(events, admitted, characters, Windows::default())
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
    characters: &HashMap<u32, CharacterType>,
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
        let mut hit_shares = HitShares::new(&evidence.hits, characters.get(&actor_index).copied());

        for (at, residual) in residuals(&evidence.rises, &evidence.read_gains, windows.poll_lag_ms)
        {
            // EVERY tick consumes its hits, even one that gets no verdict —
            // a hit's grant surfaced at its own tick, and leaving it unspent
            // would let a later residual claim it.
            let (shares, total_weight) = hit_shares.for_tick(at, &windows);

            if residual < MIN_RESIDUAL {
                continue;
            }

            // Rule order is a precision order, not a preference. The flat grant
            // is an exact value match and goes first: a chain contribution that
            // happens to land beside the recipient's own swing would otherwise
            // be read as that swing's output and inflate the move's row.
            if is_flat_grant(residual) {
                verdicts.push((
                    InferredGain {
                        at,
                        actor_index,
                        cause: SbaGainCause::InferredChainGrant,
                        amount: residual,
                    },
                    Rule::FlatGrant,
                ));
            } else if total_weight > 0.0 {
                // The share formula: each action's slice of the residual is
                // its authored weight over the tick's total. K cancels.
                for (action, weight) in shares {
                    verdicts.push((
                        InferredGain {
                            at,
                            actor_index,
                            cause: SbaGainCause::Inferred(action),
                            amount: residual * weight / total_weight,
                        },
                        Rule::Share,
                    ));
                }
            } else if evidence
                .taken
                .iter()
                .any(|taken_at| (taken_at - at).abs() <= windows.taken_ms)
            {
                verdicts.push((
                    InferredGain {
                        at,
                        actor_index,
                        cause: SbaGainCause::InferredDamageTaken,
                        amount: residual,
                    },
                    Rule::DamageTaken,
                ));
            }
            // Nothing explains it: the remainder keeps it, which is the honest
            // outcome — this module's job is to shrink that band only where it
            // can say why.
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

    /// Gran's character-type hash as it appears on the wire (see
    /// `CharacterType::from_hash`).
    const GRAN_HASH: u32 = 0x26A4_848A;

    fn always(_: i64) -> bool {
        true
    }

    /// No identity in the log: every action prices at the 1.0 fallback.
    fn no_party() -> HashMap<u32, CharacterType> {
        HashMap::new()
    }

    fn party_of(character: CharacterType) -> HashMap<u32, CharacterType> {
        HashMap::from([(PLAYER, character)])
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
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        })
    }

    /// The supplementary tick a skill triggers. Its own damage event, carrying
    /// the id of the skill that caused it.
    fn echo(source: u32, target: u32, action: u32) -> Message {
        let Message::DamageEvent(mut event) = hit(source, target, action) else {
            unreachable!()
        };
        event.action_id = ActionType::SupplementaryDamage(action);
        Message::DamageEvent(event)
    }

    fn link(source: u32, target: u32) -> Message {
        let Message::DamageEvent(mut event) = hit(source, target, 0) else {
            unreachable!()
        };
        event.action_id = ActionType::LinkAttack;
        Message::DamageEvent(event)
    }

    fn dot(source: u32, target: u32) -> Message {
        let Message::DamageEvent(mut event) = hit(source, target, 0) else {
            unreachable!()
        };
        event.action_id = ActionType::DamageOverTime(1);
        Message::DamageEvent(event)
    }

    /// The alias map covers both key spaces a party member answers to: the
    /// roster's raw entity index, and the slot key that rises and player-keyed
    /// hits arrive under. Identity lives in the roster, not the event log —
    /// the live path folds identity events into `player_data` without storing
    /// them — so this is the only bridge the weight lookup gets.
    #[test]
    fn character_aliases_cover_both_key_spaces() {
        let mut parser = super::super::Parser::default();
        let mut event = crate::debug_events::identity_event(0, GRAN_HASH, "Gran");
        event.actor_index = 0x0001_0000;
        parser.on_player_identity_event(event);

        let aliases = character_aliases(&parser.encounter.player_data);
        assert_eq!(aliases.get(&0x0001_0000), Some(&CharacterType::Pl0000));
        assert_eq!(aliases.get(&PLAYER), Some(&CharacterType::Pl0000));
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
        infer(events, &always, &no_party())
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
            infer(&events, &always, &no_party()),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 12.5,
            }]
        );
    }

    /// Two actions in the interval split the rise by weight. With no identity
    /// event in the log the character is unknown, both actions fall back to the
    /// game's default weight of 1.0, and the split is even.
    #[test]
    fn two_actions_split_a_rise_by_hit_count() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, hit(PLAYER, ENEMY, 77)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            infer(&events, &always, &no_party()),
            vec![
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                    amount: 6.25,
                },
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::Normal(77)),
                    amount: 6.25,
                },
            ]
        );
    }

    /// The headline of the weight table: a known character's rise splits by the
    /// AUTHORED weights, not evenly. Gran's action 100 is authored 0.5 and 205
    /// is 0.8, so 13.0 gauge splits 5.0 / 8.0.
    #[test]
    fn authored_weights_split_a_rise_proportionally() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 100)),
            (102, hit(PLAYER, ENEMY, 205)),
            (104, rise(PLAYER, 13.0)),
        ];

        assert_eq!(
            infer(&events, &always, &party_of(CharacterType::Pl0000)),
            vec![
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::Normal(100)),
                    amount: 5.0,
                },
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::Normal(205)),
                    amount: 8.0,
                },
            ]
        );
    }

    /// A link attack carries the authored weight 5.0 for every character, so it
    /// takes the lion's share of a rise it splits with an ordinary swing.
    #[test]
    fn a_link_attack_takes_its_authored_share() {
        let events = vec![
            (100, link(PLAYER, ENEMY)),
            (102, hit(PLAYER, ENEMY, 100)),
            (104, rise(PLAYER, 11.0)),
        ];

        assert_eq!(
            infer(&events, &always, &party_of(CharacterType::Pl0000)),
            vec![
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::LinkAttack),
                    amount: 10.0,
                },
                InferredGain {
                    at: 104,
                    actor_index: PLAYER,
                    cause: SbaGainCause::Inferred(ActionType::Normal(100)),
                    amount: 1.0,
                },
            ]
        );
    }

    /// An action authored at weight 0 is one the SBA gate refuses — it must
    /// not dilute the share of the hits that actually paid. Katalina's action
    /// 4 is authored 0.0; the other action is unknown and falls back to 1.0.
    #[test]
    fn a_zero_weight_action_is_excluded_from_the_share() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 4)),
            (102, hit(PLAYER, ENEMY, 9999)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            infer(&events, &always, &party_of(CharacterType::Pl0200)),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(9999)),
                amount: 12.5,
            }]
        );
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

    /// An echo is CAUSED BY the skill beside it, so the two are one candidate
    /// and not two. Treating them as rival actions was self-inflicted
    /// ambiguity: roughly half of every player's damage events in a real online
    /// log are echoes, so nearly every skill that echoes was disqualifying its
    /// own rise (log 2619: it cost 19%→51% of one remote's attributable gauge).
    #[test]
    fn an_echo_does_not_compete_with_the_skill_that_caused_it() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, echo(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// An echo grants no gauge of its own — corpus-measured: 1.34M
    /// supplementary hits across 1,855 logs produced zero captioned grants. A
    /// rise beside nothing but an echo is therefore something else entirely,
    /// and stays unnamed.
    #[test]
    fn an_echo_alone_explains_nothing() {
        let events = vec![(100, echo(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// Because an echo weighs nothing, an echo of a DIFFERENT skill does not
    /// dilute the share of the hit that actually paid.
    #[test]
    fn an_echo_of_another_skill_does_not_dilute_the_share() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, echo(PLAYER, ENEMY, 77)),
            (104, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// Damage-over-time ticks likewise grant nothing (80K DoT hits, zero
    /// captioned grants) — a rise beside only a DoT tick stays unnamed.
    #[test]
    fn a_dot_tick_explains_nothing() {
        let events = vec![(100, dot(PLAYER, ENEMY)), (104, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// Another player's hit is not evidence about this player's gauge.
    #[test]
    fn another_players_hit_does_not_explain_this_players_rise() {
        let events = vec![(100, hit(OTHER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// A hit within the lookback pays into a later rise — a remote's grant
    /// only surfaces at the poll emission after its sync lands, which can trail
    /// the hit by a rise cadence or more.
    #[test]
    fn a_hit_within_the_lookback_pays_into_a_later_rise() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (400, rise(PLAYER, 12.5))];

        assert_eq!(
            causes(&events),
            vec![SbaGainCause::Inferred(ActionType::Normal(42))]
        );
    }

    /// A hit beyond the lookback explains nothing: if it had granted, a rise
    /// would have surfaced within a poll cadence of the sync, not 800 ms later.
    #[test]
    fn a_distant_hit_does_not_attribute() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (900, rise(PLAYER, 12.5))];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// A hit pays into only the FIRST tick that reports it. The next tick's
    /// residual is new gauge, and re-counting the same hit for it would name
    /// someone else's gauge after that hit's own rise already did.
    #[test]
    fn a_hit_pays_into_only_the_first_tick_that_reports_it() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (104, rise(PLAYER, 12.5)),
            (360, rise(PLAYER, 9.0)),
        ];

        assert_eq!(
            infer(&events, &always, &no_party()),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 12.5,
            }]
        );
    }

    /// The flat chain grant is recognised by value, and beats the share rule —
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

    /// The player's own action outranks an incoming hit: the share rule is the
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

        assert!(infer(&events, &always, &no_party()).is_empty());
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
            infer(&events, &always, &no_party()),
            vec![InferredGain {
                at: 104,
                actor_index: PLAYER,
                cause: SbaGainCause::Inferred(ActionType::Normal(42)),
                amount: 20.0,
            }]
        );
    }

    /// One read gain cannot cancel two rises: it is spent by the first, so a
    /// later rise with its own hit is still named.
    #[test]
    fn a_read_gain_is_spent_by_the_rise_it_explains() {
        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 12.5)),
            (104, rise(PLAYER, 12.5)),
            (300, hit(PLAYER, ENEMY, 42)),
            (304, rise(PLAYER, 12.5)),
        ];

        assert_eq!(
            infer(&events, &always, &no_party()),
            vec![InferredGain {
                at: 304,
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

        assert!(infer(&events, &always, &no_party()).is_empty());
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
    /// one — the overflow is the same accrual, reported a tick later. The
    /// residual walk keeps that property (pinned here directly), but the
    /// leftover 5 gets NO verdict: the hit's own grant was the 30 the hook
    /// read, so the unexplained remainder is gauge from an unlocated source,
    /// not the hit again.
    #[test]
    fn a_read_gain_larger_than_its_tick_carries_forward() {
        assert_eq!(
            residuals(&[(104, 10.0), (130, 25.0)], &[(102, 30.0)], 16),
            vec![(104, 0.0), (130, 5.0)]
        );

        let events = vec![
            (100, hit(PLAYER, ENEMY, 42)),
            (102, read_gain(PLAYER, 30.0)),
            (104, rise(PLAYER, 10.0)),
            (130, rise(PLAYER, 25.0)),
        ];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// Noise-sized residues are not worth a verdict.
    #[test]
    fn a_tiny_residual_is_left_alone() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 0.2))];

        assert!(infer(&events, &always, &no_party()).is_empty());
    }

    /// Events the reparse excluded must be invisible here too, or inferred
    /// gauge would exceed the polled total it is splitting.
    #[test]
    fn excluded_events_are_not_evidence() {
        let events = vec![(100, hit(PLAYER, ENEMY, 42)), (104, rise(PLAYER, 12.5))];
        let admitted = |timestamp: i64| timestamp >= 200;

        assert!(infer(&events, &admitted, &no_party()).is_empty());
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

        let actors: Vec<_> = infer(&events, &always, &no_party())
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

        let verdicts = infer(&events, &always, &no_party());
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

        let rules: Vec<_> = infer_tagged(&events, &always, &no_party(), Windows::default())
            .into_iter()
            .map(|(_, rule)| rule)
            .collect();
        assert_eq!(rules, vec![Rule::Share, Rule::FlatGrant, Rule::DamageTaken]);
    }
}
