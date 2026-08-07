//! Rate limiting and change detection for the live overlay's Tauri events.
//!
//! The meter is fed by three events that the parser emits from inside the
//! damage path — `encounter-update`, `encounter-party-update` and
//! `encounter-legality-update`. Every one of them was emitted per hit, so a
//! fight drove the overlay's React tree at the game's hit rate: measured at
//! 26.2 commits/second, against the ~2/second the 500ms clock needs. Nothing
//! leaked; the cost was the churn, which pushed V8 to grow its heap from 69MB
//! to 119MB and burned CPU re-running an unmemoized render on every hit.
//!
//! Two independent controls live here, both pure so they can be tested without
//! a Tauri window:
//!
//! * [`EmitThrottle`] coalesces a stream of updates down to one per interval.
//!   It is a *trailing* throttle: the update that arrives during a closed
//!   window is remembered, not dropped, so the last state of a fight always
//!   reaches the screen even though the hit that produced it was suppressed.
//! * [`snapshot_changed`] answers "is this actually new?" for the party and
//!   legality payloads, which are rebuilt from game memory on every hit but
//!   almost never differ between hits.

use serde::Serialize;

/// How often the live overlay is allowed to be told the encounter changed.
///
/// 10Hz: comfortably faster than the eye reads a DPS number, and far below the
/// rate the game lands hits at. The overlay's own clock already re-renders it
/// twice a second, so this is the term that dominates.
pub const LIVE_UPDATE_INTERVAL_MS: i64 = 100;

/// Admits at most one emit per `min_interval_ms`, remembering a suppressed
/// update so a later flush can deliver the newest state.
///
/// Time is passed in rather than read so the caller keeps one clock and the
/// tests keep a deterministic one.
#[derive(Debug)]
pub struct EmitThrottle {
    min_interval_ms: i64,
    last_emit_ms: Option<i64>,
    /// An update arrived while the window was closed and has not been sent yet.
    suppressed: bool,
}

impl Default for EmitThrottle {
    fn default() -> Self {
        Self::new(LIVE_UPDATE_INTERVAL_MS)
    }
}

impl EmitThrottle {
    pub fn new(min_interval_ms: i64) -> Self {
        Self {
            min_interval_ms,
            last_emit_ms: None,
            suppressed: false,
        }
    }

    /// Fresh state is ready. Returns true when it should be emitted now.
    ///
    /// A false return is not a drop: the state is marked pending and
    /// [`flush_due`](Self::flush_due) will release it once the window opens.
    pub fn admit(&mut self, now_ms: i64) -> bool {
        if self.window_open(now_ms) {
            self.last_emit_ms = Some(now_ms);
            self.suppressed = false;
            true
        } else {
            self.suppressed = true;
            false
        }
    }

    /// Called from a timer, not the damage path. Returns true when an update
    /// was suppressed earlier and the interval has since elapsed, meaning the
    /// caller should emit the latest state now.
    pub fn flush_due(&mut self, now_ms: i64) -> bool {
        if self.suppressed && self.window_open(now_ms) {
            self.last_emit_ms = Some(now_ms);
            self.suppressed = false;
            true
        } else {
            false
        }
    }

    /// Encounter boundary: the next update is the first of a new fight and must
    /// not wait behind the previous fight's emit.
    pub fn reset(&mut self) {
        self.last_emit_ms = None;
        self.suppressed = false;
    }

    fn window_open(&self, now_ms: i64) -> bool {
        match self.last_emit_ms {
            None => true,
            // Saturating: a clock that steps backwards must not latch the
            // throttle closed for the rest of the quest.
            Some(last) => now_ms.saturating_sub(last) >= self.min_interval_ms,
        }
    }
}

/// True when `incoming` differs from what was last published, i.e. when it is
/// worth paying for an emit.
///
/// `PartialEq` alone cannot answer this. These payloads carry `f32`s read out
/// of game memory, and NaN is never equal to itself, so a single NaN anywhere
/// in the party would make every hit look like a change and defeat the gate
/// permanently — the failure mode the derived comparison was already warned
/// about at the legality audit. Falling back to the encoded bytes settles it:
/// bincode preserves the exact bit pattern, so NaN matches NaN.
///
/// The byte comparison is only reached when `PartialEq` already said "different",
/// which is the rare case; the steady state of an unchanged party short-circuits
/// on the cheap comparison and allocates nothing.
pub fn snapshot_changed<T>(current: Option<&T>, incoming: &T) -> bool
where
    T: PartialEq + Serialize,
{
    let Some(current) = current else {
        // Never published: the first sight is always a change.
        return true;
    };
    if current == incoming {
        return false;
    }
    match (
        protocol::bincode::serialize(current),
        protocol::bincode::serialize(incoming),
    ) {
        (Ok(a), Ok(b)) => a != b,
        // Unencodable: fall back to the comparison we already have rather than
        // silently swallowing a real change.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_update_emits_immediately() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
    }

    #[test]
    fn update_inside_the_interval_is_suppressed() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        assert!(!throttle.admit(1_050));
    }

    #[test]
    fn update_after_the_interval_emits() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        assert!(!throttle.admit(1_050));
        assert!(throttle.admit(1_100));
    }

    /// The property that makes this a throttle and not a sampler: the state
    /// produced by the last hit of a fight is suppressed, and must still land.
    #[test]
    fn a_suppressed_update_is_released_by_the_flush() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        assert!(!throttle.admit(1_010));
        assert!(!throttle.flush_due(1_050), "interval has not elapsed yet");
        assert!(
            throttle.flush_due(1_100),
            "the pending state must be released"
        );
    }

    #[test]
    fn the_flush_does_nothing_when_no_update_was_suppressed() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        assert!(!throttle.flush_due(5_000));
    }

    #[test]
    fn the_flush_releases_a_pending_update_only_once() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        assert!(!throttle.admit(1_010));
        assert!(throttle.flush_due(1_100));
        assert!(!throttle.flush_due(1_200));
    }

    /// The rate the live overlay actually runs at. Pinned because it is the
    /// whole point of the change: the meter used to commit at the game's hit
    /// rate, and 10Hz is the ceiling everything downstream is sized for.
    #[test]
    fn the_default_throttle_runs_at_ten_hertz() {
        let mut throttle = EmitThrottle::default();
        assert!(throttle.admit(0));
        assert!(!throttle.admit(99));
        assert!(throttle.admit(100));
    }

    #[test]
    fn a_reset_lets_the_next_fight_emit_immediately() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(1_000));
        throttle.reset();
        assert!(throttle.admit(1_001));
    }

    #[test]
    fn a_backwards_clock_does_not_latch_the_throttle_closed() {
        let mut throttle = EmitThrottle::new(100);
        assert!(throttle.admit(10_000));
        // Earlier than the last emit; saturating_sub yields 0, so the window is
        // shut, but the next in-order tick must still open it.
        assert!(!throttle.admit(9_000));
        assert!(throttle.admit(10_100));
    }

    #[derive(Debug, PartialEq, Serialize)]
    struct Snapshot {
        name: &'static str,
        crit_rate: f32,
    }

    #[test]
    fn an_unpublished_snapshot_is_always_a_change() {
        let incoming = Snapshot {
            name: "mei",
            crit_rate: 0.5,
        };
        assert!(snapshot_changed(None, &incoming));
    }

    #[test]
    fn an_identical_snapshot_is_not_rebroadcast() {
        let current = Snapshot {
            name: "mei",
            crit_rate: 0.5,
        };
        let incoming = Snapshot {
            name: "mei",
            crit_rate: 0.5,
        };
        assert!(!snapshot_changed(Some(&current), &incoming));
    }

    #[test]
    fn a_differing_snapshot_is_rebroadcast() {
        let current = Snapshot {
            name: "mei",
            crit_rate: 0.5,
        };
        let incoming = Snapshot {
            name: "mei",
            crit_rate: 0.75,
        };
        assert!(snapshot_changed(Some(&current), &incoming));
    }

    /// The gate has to survive the value the game actually hands us. Derived
    /// `PartialEq` reports two NaN-bearing snapshots as different forever,
    /// which would re-broadcast the whole party on every hit — exactly the
    /// cost this module exists to remove.
    #[test]
    fn a_nan_snapshot_is_not_rebroadcast_against_itself() {
        let current = Snapshot {
            name: "mei",
            crit_rate: f32::NAN,
        };
        let incoming = Snapshot {
            name: "mei",
            crit_rate: f32::NAN,
        };
        assert_ne!(
            current, incoming,
            "precondition: PartialEq considers NaN-bearing snapshots unequal"
        );
        assert!(!snapshot_changed(Some(&current), &incoming));
    }

    #[test]
    fn a_nan_snapshot_still_reports_a_real_change() {
        let current = Snapshot {
            name: "mei",
            crit_rate: f32::NAN,
        };
        let incoming = Snapshot {
            name: "id",
            crit_rate: f32::NAN,
        };
        assert!(snapshot_changed(Some(&current), &incoming));
    }
}
