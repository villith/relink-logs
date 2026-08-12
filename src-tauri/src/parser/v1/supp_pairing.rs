//! Which hit caused which supplementary-damage event.
//!
//! Nothing on the wire links them. `SupplementaryDamage(n)` carries the
//! trigger's ACTION ID, not the trigger's identity, and [`DamageEvent`] has no
//! trigger field. The link is inferred from order.
//!
//! Measured over 227 logs and 189,356 echoes (`examples/supp_pair_probe.rs`).
//! The rule below leaves 0.54% of echoes unpaired and never picked a trigger
//! on a different target in the measured corpus — a property of that data, not
//! an invariant the code enforces (see
//! `falls_back_across_targets_when_no_candidate_shares_the_echos_target`).
//! Its evidence is the variant that ignores targets
//! entirely: pairing on order alone still lands on the echo's own target 99.29%
//! of the time, so ordering is finding the real hit rather than a plausible
//! one. Paired ratios then concentrate on clean multiples of 0.05 — 56,172 at
//! exactly 0.600 — which random mispairing cannot produce.
//!
//! Positions, not event references: the group walk remaps dragon-form hits
//! before aggregating them, and a position survives that untouched.
//!
//! An earlier note claimed pairing was impossible, citing "<=7.7%" from
//! `examples/supp_scan.rs`. That figure scored pairings against a 0.2/0.4 ratio
//! hypothesis the 0.600 finding superseded; it never measured whether a pairing
//! was right. Do not cite it.
//!
//! [`DamageEvent`]: protocol::DamageEvent

use std::collections::{HashMap, VecDeque};

use protocol::{ActionType, Message};

/// How long a hit stays claimable by an echo.
///
/// An echo trails its trigger by 151ms at the median and 169ms at p99 (log
/// 2573), so this is roughly three times the observed tail. Re-derive it with
/// `examples/supp_pair_probe.rs` after a game patch — a shifted lag shows up
/// there as a rising orphan rate.
pub const PAIRING_WINDOW_MS: i64 = 500;

/// A hit waiting to be claimed.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    position: usize,
    timestamp: i64,
    target_index: u32,
    target_actor_type: u32,
}

/// Drops the candidates at the front of `queue` that are too old to have caused
/// anything landing at `now`. Front-to-back is sufficient because the walk
/// pushes in timestamp order, so the queue is sorted.
fn expire(queue: &mut VecDeque<Candidate>, now: i64) {
    while queue
        .front()
        .is_some_and(|c| now - c.timestamp > PAIRING_WINDOW_MS)
    {
        queue.pop_front();
    }
}

/// Echo/trigger links for one event log, keyed by position in that log.
#[derive(Debug, Default)]
pub struct SuppPairing {
    /// Echo position -> the position of the hit that triggered it.
    trigger_of: HashMap<usize, usize>,
    /// Trigger position -> its (echo position, echo damage), in stream order.
    echoes_of: HashMap<usize, Vec<(usize, i64)>>,
}

impl SuppPairing {
    /// Learned from the WHOLE log, ignoring every query filter. A pairing that
    /// changed with the scrub window would make a landing's amount depend on
    /// what the reader happened to have selected.
    ///
    /// Positional contract: every position returned by [`Self::trigger_of`] and
    /// [`Self::echoes_of`] indexes the slice passed in here. Pass the full
    /// `raw_event_log` — a caller that pairs over `&events[offset..end]` gets
    /// positions relative to that sub-slice and must add `offset` back. Getting
    /// this wrong attributes echoes to the wrong hits silently; nothing panics.
    ///
    /// Takes a slice rather than an iterator (unlike the sibling
    /// `PhantomTargets::learned_from`) precisely because positions need a
    /// stable base. Do not "unify" the two signatures.
    pub fn learned_from(events: &[(i64, Message)]) -> Self {
        let mut pairing = Self::default();
        let mut queues: HashMap<(u32, u32, u32), VecDeque<Candidate>> = HashMap::new();

        for (position, (timestamp, message)) in events.iter().enumerate() {
            let Message::DamageEvent(event) = message else {
                continue;
            };
            let timestamp = *timestamp;

            match event.action_id {
                // Only `Normal` hits are candidates, which is exactly what the
                // probe measured. A link attack or an SBA that procs leaves an
                // orphan rather than a guess, and orphans keep today's
                // behaviour.
                ActionType::Normal(aid) if event.damage > 0 => {
                    let queue = queues
                        .entry((event.source.index, event.source.actor_type, aid))
                        .or_default();
                    // Same expiry the echo arm applies, paid here too. An
                    // action that never procs is never otherwise drained, so
                    // without this its queue retains every hit of the fight;
                    // with it each queue holds one window's worth. Nothing
                    // moves: an echo arrives no earlier than this hit, so a
                    // candidate already expired against `timestamp` could not
                    // have been claimed later either.
                    expire(queue, timestamp);
                    queue.push_back(Candidate {
                        position,
                        timestamp,
                        target_index: event.target.index,
                        target_actor_type: event.target.actor_type,
                    });
                }
                ActionType::SupplementaryDamage(aid) => {
                    let queue = queues
                        .entry((event.source.index, event.source.actor_type, aid))
                        .or_default();

                    // Drop candidates too old to have caused this. Without
                    // this, a hit that never procced shifts every later echo
                    // for its action by one, and the desync never corrects.
                    expire(queue, timestamp);

                    let picked = queue
                        .iter()
                        .position(|c| {
                            c.target_index == event.target.index
                                && c.target_actor_type == event.target.actor_type
                        })
                        .and_then(|at| queue.remove(at))
                        .or_else(|| queue.pop_front());

                    if let Some(trigger) = picked {
                        pairing.trigger_of.insert(position, trigger.position);
                        // `damage` is signed and the wire can carry a negative
                        // (a heal or an absorb routed through the damage path),
                        // which would subtract from the landing it rides. Clamp
                        // so a merged total never falls below the real hit.
                        // Note the asymmetry: a consumer summing `echoes_of`
                        // sees the clamp, one reading the raw event does not.
                        pairing
                            .echoes_of
                            .entry(trigger.position)
                            .or_default()
                            .push((position, event.damage.max(0) as i64));
                    }
                }
                _ => {}
            }
        }
        pairing
    }

    /// The hit that caused the echo at `position`, or `None` for an orphan.
    pub fn trigger_of(&self, position: usize) -> Option<usize> {
        self.trigger_of.get(&position).copied()
    }

    /// The echoes riding the hit at `position`, in stream order. Empty for a
    /// hit that never procced and for every non-trigger event.
    ///
    /// At most one entry in today's data — a trigger hosts one echo or none
    /// (see `a_trigger_hosts_one_echo_and_the_surplus_orphans`). A slice
    /// rather than an `Option` because callers fold it into a sum, and because
    /// a non-consuming rule could be swapped in without touching them.
    pub fn echoes_of(&self, position: usize) -> &[(usize, i64)] {
        self.echoes_of
            .get(&position)
            .map_or(&[][..], |echoes| echoes.as_slice())
    }

    /// Visits every LANDING among `walked`, in stream order.
    ///
    /// Calls `landing(record, amount, attached)` once per event that stands as
    /// a landing of its own: `amount` is the record's own amount plus every
    /// echo that rode it, and `attached` is that echo part alone. An event
    /// whose trigger also survived is not a landing and is skipped — its
    /// damage is already inside its trigger's `amount`.
    ///
    /// Gated on what SURVIVED the caller's query, both directions: a claimed
    /// echo whose trigger was filtered out stands alone rather than letting its
    /// damage vanish, and a trigger only absorbs echoes that survived alongside
    /// it. That is what keeps the raw and landing views summing to one total
    /// under any window, span or mask.
    ///
    /// Written here rather than at each caller because both walks — the group
    /// aggregates' and the derived state's — need this exact gate, and its
    /// failures are silent in both: a mis-gated claim moves damage onto a row
    /// nobody checks. The callers differ only in how they ADDRESS a row and in
    /// the width of their amounts, neither of which this looks at.
    pub fn for_each_landing<W: Walked>(
        &self,
        walked: &[W],
        mut landing: impl FnMut(&W, W::Amount, W::Amount),
    ) {
        // Callers push in `events.iter().enumerate()` order and at most once
        // per position, so `walked` is strictly ascending by position —
        // membership is a binary search rather than a set built for one pass.
        // Asserted rather than assumed: a walk that ever pushed twice for one
        // event would make the search pick between them arbitrarily.
        debug_assert!(
            walked
                .windows(2)
                .all(|pair| pair[0].position() < pair[1].position()),
            "the landing fold needs the walk's records strictly ascending by position"
        );
        let survivor = |position: usize| -> Option<&W> {
            walked
                .binary_search_by_key(&position, |entry| entry.position())
                .ok()
                .map(|at| &walked[at])
        };

        for record in walked {
            let position = record.position();
            if self
                .trigger_of(position)
                .is_some_and(|trigger| survivor(trigger).is_some())
            {
                continue;
            }
            // The echo's amount as the WALK recorded it, never as the pairing
            // stored it: one number, one source. The two need not even be the
            // same number — this module clamps a negative with `.max(0)` while
            // a walk may store the raw figure — and taking the walk's is what
            // keeps each caller's sum invariant true.
            let attached: W::Amount = self
                .echoes_of(position)
                .iter()
                .filter_map(|(echo, _)| survivor(*echo))
                .map(|echo| echo.amount())
                .sum();
            landing(record, record.amount() + attached, attached);
        }
    }
}

/// One event a caller's walk kept, as [`SuppPairing::for_each_landing`] needs to
/// see it. Everything else a walk records — which row the event fed, whether it
/// was an echo — belongs to the caller and is read back off `&W` in the
/// callback.
pub trait Walked {
    /// `i64` for the group aggregates, `u64` for the breakdown rows.
    type Amount: Copy + std::ops::Add<Output = Self::Amount> + std::iter::Sum<Self::Amount>;

    /// Index into the SAME slice [`SuppPairing::learned_from`] walked. Pairing
    /// positions are meaningless against any other base — see that method's
    /// positional contract.
    fn position(&self) -> usize;

    /// What the walk aggregated for this event, past every gate and clamp — the
    /// single source of truth for what it contributed.
    fn amount(&self) -> Self::Amount;
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Actor, DamageEvent, OnPlayerStunEvent};

    fn actor(index: u32) -> Actor {
        Actor {
            index,
            actor_type: 0x100,
            parent_index: index,
            parent_actor_type: 0x100,
        }
    }

    /// One damage event at `ts`, from source 0 onto `target`.
    fn event(ts: i64, action_id: ActionType, damage: i32, target: u32) -> (i64, Message) {
        (
            ts,
            Message::DamageEvent(DamageEvent {
                source: actor(0),
                target: actor(target),
                damage,
                flags: 0,
                action_id,
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
            }),
        )
    }

    #[test]
    fn attaches_an_echo_to_the_hit_that_triggered_it() {
        let events = [
            event(0, ActionType::Normal(9001), 154_500, 7),
            event(151, ActionType::SupplementaryDamage(9001), 92_681, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(1), Some(0));
        assert_eq!(pairing.echoes_of(0), &[(1, 92_681)]);
    }

    /// The whole reason expiry exists: ~2% of hits never proc, and without it
    /// each one strands a candidate that shifts every later echo by one.
    #[test]
    fn a_trigger_that_never_procced_stops_claiming_later_echoes() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(5_000, ActionType::Normal(9001), 200, 7),
            event(5_151, ActionType::SupplementaryDamage(9001), 120, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(
            pairing.trigger_of(2),
            Some(1),
            "the 5s-stale hit must not claim it"
        );
        assert!(pairing.echoes_of(0).is_empty());
    }

    #[test]
    fn prefers_a_candidate_on_the_echos_own_target() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(10, ActionType::Normal(9001), 200, 8),
            event(160, ActionType::SupplementaryDamage(9001), 120, 8),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(
            pairing.trigger_of(2),
            Some(1),
            "target 8's hit, not the older one"
        );
    }

    /// No same-target candidate in window, so the fallback takes the queue
    /// front — which pairs ACROSS targets. The corpus never exercised this
    /// (strategy C measured 0.00% cross-target pairs), so it is behaviour the
    /// rule permits rather than behaviour it was chosen for. Pinned so a
    /// future edit cannot change it silently.
    #[test]
    fn falls_back_across_targets_when_no_candidate_shares_the_echos_target() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(150, ActionType::SupplementaryDamage(9001), 60, 8),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(1), Some(0));
    }

    /// Exactly at the window is still claimable — the comparison is `>`, not
    /// `>=`. Pinned because the boundary is invisible to a test that uses a
    /// gap ten times the window.
    #[test]
    fn a_candidate_exactly_at_the_window_is_still_claimable() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(
                PAIRING_WINDOW_MS,
                ActionType::SupplementaryDamage(9001),
                60,
                7,
            ),
        ];
        assert_eq!(SuppPairing::learned_from(&events).trigger_of(1), Some(0));
    }

    #[test]
    fn a_candidate_one_millisecond_past_the_window_has_expired() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(
                PAIRING_WINDOW_MS + 1,
                ActionType::SupplementaryDamage(9001),
                60,
                7,
            ),
        ];
        assert_eq!(SuppPairing::learned_from(&events).trigger_of(1), None);
    }

    /// Positions enumerate over ALL messages, not just damage ones. The probe
    /// that validated the rule walked a damage-only Vec, so this is the one
    /// place the implementation and its evidence legitimately diverge — and
    /// every real consumer walks a mixed stream.
    #[test]
    fn a_non_damage_message_still_occupies_a_position() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            (
                75,
                Message::OnPlayerStun(OnPlayerStunEvent {
                    actor_index: 0,
                    stun_amount: 12.5,
                }),
            ),
            event(150, ActionType::SupplementaryDamage(9001), 60, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(2), Some(0));
        assert_eq!(pairing.echoes_of(0), &[(2, 60)]);
    }

    /// A trigger hosts at most ONE echo; a surplus echo orphans.
    ///
    /// Not a limitation of the rule but a property of the data. Paired WITHOUT
    /// the expiry, log 2573 resolves 1,778 echoes against 1,801 hits with zero
    /// orphans, leaving 23 hits that never procced — and 1,778 + 23 = 1,801
    /// exactly, so every trigger took one echo or none. (The rule as
    /// implemented adds expiry and orphans 7 of those echoes, whose trigger
    /// aged out; that narrows the pairing, it does not create second echoes.)
    ///
    /// A second echo on one hit therefore takes the orphan path, where its
    /// damage still counts as its own landing rather than being lost.
    #[test]
    fn a_trigger_hosts_one_echo_and_the_surplus_orphans() {
        let events = [
            event(0, ActionType::Normal(9001), 100, 7),
            event(150, ActionType::SupplementaryDamage(9001), 60, 7),
            event(160, ActionType::SupplementaryDamage(9001), 20, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.echoes_of(0), &[(1, 60)]);
        assert_eq!(pairing.trigger_of(2), None);
    }

    /// Surplus echoes and echoes whose cause was never a `Normal` hit have no
    /// trigger. They keep today's behaviour: their own hit, on the echo row.
    #[test]
    fn an_echo_with_no_candidate_is_an_orphan() {
        let events = [event(0, ActionType::SupplementaryDamage(4242), 70, 7)];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(0), None);
    }

    /// Action ids are numbered per character, so a bare id would let one
    /// player's echo claim another player's hit.
    #[test]
    fn a_hit_from_another_source_is_not_a_candidate() {
        let mut other = event(0, ActionType::Normal(9001), 100, 7);
        if let Message::DamageEvent(e) = &mut other.1 {
            e.source = actor(3);
        }
        let events = [
            other,
            event(150, ActionType::SupplementaryDamage(9001), 60, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(1), None);
    }

    /// A zero-damage hit is not a landing worth attaching to, and it would
    /// divide by nothing in the ratio the events panel shows.
    #[test]
    fn a_zero_damage_hit_is_not_a_candidate() {
        let events = [
            event(0, ActionType::Normal(9001), 0, 7),
            event(150, ActionType::SupplementaryDamage(9001), 60, 7),
        ];
        let pairing = SuppPairing::learned_from(&events);

        assert_eq!(pairing.trigger_of(1), None);
    }
}
