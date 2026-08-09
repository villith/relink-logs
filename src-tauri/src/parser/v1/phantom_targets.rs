//! Which damage TARGETS the meters count.
//!
//! Some skills spawn a short-lived object that the game treats as a damageable
//! actor: it is handed a full damage instance, dies on contact, and contributes
//! nothing to the fight. Eustace's charged Flamek Thunder spawns two of them per
//! cast, so one shot arrives as three identical `DamageEvent`s — one on the
//! enemy and two on markers — and a naive sum books the cast three times. Live
//! example (log 562, solo Eustace vs Sir Barrold), all at the same millisecond:
//!
//! ```text
//! tgt=0xa379ac65 act=Normal(1602) dmg=4174929 hp=21511134/39000000  <- the enemy
//! tgt=0xa90f5847 act=Normal(1602) dmg=4174929 hp=0/1                <- marker
//! tgt=0xa90f5847 act=Normal(1602) dmg=4174929 hp=0/1                <- marker
//! ```
//!
//! That was 18.2% of the encounter's logged damage, which is why the meter and
//! the in-game score disagree — the score only counts what reached the enemy.
//!
//! Two rules, because neither covers the other:
//!
//! * [`EXCLUDED_TARGET_TYPES`] — actors identified by hand. Works on the first
//!   hit and needs no HP read, which is what the ingest door needs.
//! * The learned rule — an actor whose HP pool is only ever [`PHANTOM_MAX_HP`]
//!   or smaller is a marker, not an enemy. Self-maintaining, so a marker a
//!   future game patch adds is caught without a code change.
//!
//! The learned rule needs the "only ever" part: a single stale HP read must not
//! be able to disqualify a real boss for the rest of a fight, so one large pool
//! anywhere in the encounter permanently clears a hash. Checked against all 119
//! distinct target hashes in a 562-log database: no real enemy ever reported a
//! pool this small, and no hash mixed a tiny pool with a real one.
//!
//! Like [`super::filters`], the predicate lives on the raw [`DamageEvent`] so the
//! live overlay, the saved-log reparse and the target dropdown cannot disagree,
//! and the raw event log itself is never filtered — which is what makes this
//! retroactive: logs recorded before the rule existed lose the phantom damage
//! the next time they are opened.

use std::collections::HashMap;

use protocol::{DamageEvent, Message};

/// Actors that can receive damage but must never be counted, by actor type.
///
/// Kept as an explicit list rather than relying on the learned rule alone
/// because a listed hash is caught on its very first hit, before any HP has
/// been observed — the ingest door has nothing else to go on.
pub const EXCLUDED_TARGET_TYPES: &[u32] = &[
    // Wp0590 — Eugen's Grenade. Its own projectile, damaged by his shot.
    0x022a350f,
    // The pair of 1-HP markers Eustace's charged Flamek Thunder (action 1602)
    // spawns; each takes a full-damage instance of the same hit that lands on
    // the enemy.
    0xa90f5847,
];

/// An actor whose entire HP pool is this small is a marker, not an enemy.
///
/// Deliberately tight. The next-smallest pools seen in practice belong to real
/// (if weak) enemies whose incoming damage is proportional to that pool, and
/// widening this would start swallowing them.
pub const PHANTOM_MAX_HP: u64 = 1;

/// The largest HP pool seen for each target actor type, which is all the
/// learned rule needs: a hash qualifies only if every pool ever reported for it
/// was trivially small.
#[derive(Debug, Default, Clone)]
pub struct PhantomTargets {
    largest_pool: HashMap<u32, u64>,
}

impl PhantomTargets {
    /// Learns from a whole event log up front — the reparse path, where every
    /// hit is already in hand, so a marker's hits are dropped even when the hit
    /// that revealed its HP came later (most hits carry no HP read at all).
    pub fn learned_from<'a>(log: impl Iterator<Item = &'a (i64, Message)>) -> Self {
        let mut phantoms = Self::default();
        for (_, event) in log {
            if let Message::DamageEvent(event) = event {
                phantoms.observe(event);
            }
        }
        phantoms
    }

    /// Folds one hit's HP read into what is known about its target.
    ///
    /// The live path calls this as events arrive, so a marker is only recognised
    /// from its first HP-bearing hit onward; anything before that stays in the
    /// overlay's running total and is corrected when the saved log is reparsed.
    pub fn observe(&mut self, event: &DamageEvent) {
        let Some(max_hp) = event.target_max_hp else {
            return;
        };
        let entry = self.largest_pool.entry(target_type(event)).or_insert(0);
        *entry = (*entry).max(max_hp);
    }

    /// True when `event`'s target must not reach any derived total.
    pub fn is_phantom(&self, event: &DamageEvent) -> bool {
        is_excluded_target_type(event) || self.is_learned_phantom(target_type(event))
    }

    /// True for a target type observed at least once and never with a real pool.
    fn is_learned_phantom(&self, target_type: u32) -> bool {
        self.largest_pool
            .get(&target_type)
            .is_some_and(|largest| *largest <= PHANTOM_MAX_HP)
    }
}

/// True for a hand-listed actor type, with no HP read needed.
///
/// Checks both target fields: the hook reports a target's `parent_actor_type` as
/// its own type (there is no target-side parent walk), so the two always agree,
/// and matching either keeps the list correct if that ever changes.
pub fn is_excluded_target_type(event: &DamageEvent) -> bool {
    EXCLUDED_TARGET_TYPES.contains(&event.target.actor_type)
        || EXCLUDED_TARGET_TYPES.contains(&event.target.parent_actor_type)
}

/// The hash the per-enemy breakdowns key on, so a phantom is judged by the same
/// identity it would otherwise be aggregated under.
fn target_type(event: &DamageEvent) -> u32 {
    event.target.parent_actor_type
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{ActionType, Actor};

    /// Eustace's charged Flamek Thunder marker, from the shared list rather than
    /// restated, so a hash correction after a game patch reaches these tests.
    const EUSTACE_MARKER: u32 = EXCLUDED_TARGET_TYPES[1];
    const REAL_ENEMY: u32 = 0xa379ac65; // Em2700, Sir Barrold

    /// A hit on `target_type` for `damage`, reporting `max_hp` as the target's
    /// pool (`None` for the majority of hits, which carry no HP read).
    fn hit(target_type: u32, damage: i32, max_hp: Option<u64>) -> DamageEvent {
        DamageEvent {
            source: Actor {
                index: 0,
                actor_type: 0x91418145,
                parent_index: 0,
                parent_actor_type: 0x91418145,
            },
            target: Actor {
                index: 9,
                actor_type: target_type,
                parent_index: 9,
                parent_actor_type: target_type,
            },
            damage,
            flags: 0,
            action_id: ActionType::Normal(1602),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: max_hp.map(|_| 0),
            target_max_hp: max_hp,
            class_flags: None,
            source_current_hp: None,
            source_max_hp: None,
            source_statuses: None,
        }
    }

    #[test]
    fn listed_target_types_are_phantom_without_any_hp_read() {
        // The ingest door sees the very first hit, before any HP is known.
        let phantoms = PhantomTargets::default();
        assert!(phantoms.is_phantom(&hit(EUSTACE_MARKER, 4_174_929, None)));
        assert!(phantoms.is_phantom(&hit(EXCLUDED_TARGET_TYPES[0], 1_000, None)));
    }

    #[test]
    fn a_real_enemy_is_never_phantom() {
        let mut phantoms = PhantomTargets::default();
        phantoms.observe(&hit(REAL_ENEMY, 4_174_929, Some(39_000_000)));
        assert!(!phantoms.is_phantom(&hit(REAL_ENEMY, 4_174_929, Some(39_000_000))));
        assert!(!phantoms.is_phantom(&hit(REAL_ENEMY, 4_174_929, None)));
    }

    #[test]
    fn an_unseen_target_is_not_phantom() {
        // Absence of evidence only: a target nobody has read HP for is counted.
        let phantoms = PhantomTargets::default();
        assert!(!phantoms.is_phantom(&hit(0xdeadbeef, 1_000, None)));
    }

    #[test]
    fn a_one_hp_actor_is_learned_as_phantom() {
        let mut phantoms = PhantomTargets::default();
        phantoms.observe(&hit(0x60b55c0f, 546_000, Some(1)));
        assert!(phantoms.is_phantom(&hit(0x60b55c0f, 546_000, Some(1))));
        // ...including its hits that carry no HP read at all, which in practice
        // are most of them (1070 of 1526 for this actor across the sample logs).
        assert!(phantoms.is_phantom(&hit(0x60b55c0f, 546_000, None)));
    }

    #[test]
    fn one_real_pool_anywhere_clears_a_hash_for_good() {
        // A stale or garbage HP read must not be able to erase a real boss for
        // the rest of the fight, so the largest pool wins regardless of order.
        let mut phantoms = PhantomTargets::default();
        phantoms.observe(&hit(REAL_ENEMY, 1_000, Some(1)));
        phantoms.observe(&hit(REAL_ENEMY, 1_000, Some(39_000_000)));
        assert!(!phantoms.is_phantom(&hit(REAL_ENEMY, 1_000, None)));

        let mut reversed = PhantomTargets::default();
        reversed.observe(&hit(REAL_ENEMY, 1_000, Some(39_000_000)));
        reversed.observe(&hit(REAL_ENEMY, 1_000, Some(1)));
        assert!(!reversed.is_phantom(&hit(REAL_ENEMY, 1_000, None)));
    }

    #[test]
    fn a_small_but_real_pool_is_counted() {
        // Em with a 1200-HP pool taking ~68 damage a hit: proportional, so real.
        let mut phantoms = PhantomTargets::default();
        phantoms.observe(&hit(0x5708da64, 68, Some(1_200)));
        assert!(!phantoms.is_phantom(&hit(0x5708da64, 68, None)));
    }

    #[test]
    fn learned_from_reads_the_whole_log_before_judging() {
        // The marker's first hit carries no HP; only the second reveals the pool.
        // A reparse must still drop both.
        let log = vec![
            (1_000, Message::DamageEvent(hit(0xa1b2c3d4, 999, None))),
            (2_000, Message::DamageEvent(hit(0xa1b2c3d4, 999, Some(1)))),
            (
                3_000,
                Message::DamageEvent(hit(REAL_ENEMY, 999, Some(39_000_000))),
            ),
        ];
        let phantoms = PhantomTargets::learned_from(log.iter());
        assert!(phantoms.is_phantom(&hit(0xa1b2c3d4, 999, None)));
        assert!(!phantoms.is_phantom(&hit(REAL_ENEMY, 999, None)));
    }
}
