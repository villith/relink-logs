//! Exact damage-cap detection from the game's pre-cap base damage.
//!
//! v2.0.2 exposes the pre-cap base damage in the DamageInstance (+0x2D4), so cap
//! detection no longer needs to guess from `damage/cap` ratio recurrence. A hit is
//! capped exactly when its pre-cap base exceeds the cap, and the game's in-game
//! "overcap %" display is `(base / cap) * 100` (a hit exactly at the cap reads
//! 100%; a hit 3x over reads 300%). Both `base` and `cap` are in the same pre-crit
//! space, so the comparison is direct.
//!
//! See the `gbfr-overcap-display-hook` notes for the reverse-engineering evidence
//! (the game's own formula, decoded from `OnAttackApplyAndSetupForDisplay`).

/// Is this hit capped? True exactly when the pre-cap base damage exceeds the cap.
///
/// `base` and `cap` come from the same game fields; a `None` base means the hit
/// carried no pre-cap value (old logs, non-cappable sources) and is treated as
/// uncapped. Non-positive caps are sentinels ("no cap") and never capped.
pub fn is_capped(base: Option<f32>, cap: Option<i32>) -> bool {
    let (Some(base), Some(cap)) = (base, cap) else {
        return false;
    };
    if cap <= 0 || !base.is_finite() || base <= 0.0 {
        return false;
    }
    base > cap as f32
}

/// The valid `(base, cap)` pair for one hit's overcap accumulation, in `f64`.
///
/// Returns `None` for the same non-usable inputs as [`is_capped`]/
/// [`overcap_display_percent`] (missing base/cap, non-finite/non-positive base,
/// non-positive cap sentinel), so all three share one validity rule.
pub fn overcap_contribution(base: Option<f32>, cap: Option<i32>) -> Option<(f64, f64)> {
    let (base, cap) = (base?, cap?);
    if cap <= 0 || !base.is_finite() || base <= 0.0 {
        return None;
    }
    Some((base as f64, cap as f64))
}

/// The game's overcap-display percentage for one hit: `(base / cap) * 100`.
///
/// Matches the value the in-game damage-cap display shows (a hit at the cap reads
/// 100.0, a hit twice the cap reads 200.0). Returns `None` when there's no usable
/// base/cap pair. Clamped at 0 for a (nonsensical) negative ratio, mirroring the
/// game's `vandnps` clamp.
pub fn overcap_display_percent(base: Option<f32>, cap: Option<i32>) -> Option<f64> {
    let (base, cap) = (base?, cap?);
    if cap <= 0 || !base.is_finite() || base <= 0.0 {
        return None;
    }
    Some((base as f64 / cap as f64 * 100.0).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_when_base_exceeds_cap() {
        assert!(is_capped(Some(1500.0), Some(1000)));
        // Base just over the cap is still capped.
        assert!(is_capped(Some(1000.5), Some(1000)));
    }

    #[test]
    fn not_capped_when_base_at_or_below_cap() {
        // Exactly at the cap is NOT over the cap.
        assert!(!is_capped(Some(1000.0), Some(1000)));
        assert!(!is_capped(Some(999.0), Some(1000)));
    }

    #[test]
    fn not_capped_for_missing_base_or_cap_or_sentinels() {
        assert!(!is_capped(None, Some(1000))); // old log, no base
        assert!(!is_capped(Some(1500.0), None)); // no cap info
        assert!(!is_capped(Some(1500.0), Some(0))); // zero cap sentinel
        assert!(!is_capped(Some(1500.0), Some(-1))); // -1 "no cap" sentinel
    }

    #[test]
    fn not_capped_for_nonfinite_or_nonpositive_base() {
        assert!(!is_capped(Some(f32::NAN), Some(1000)));
        assert!(!is_capped(Some(f32::INFINITY), Some(1000)));
        assert!(!is_capped(Some(0.0), Some(1000)));
        assert!(!is_capped(Some(-5.0), Some(1000)));
    }

    #[test]
    fn overcap_percent_matches_game_formula() {
        // Exactly at cap => 100%.
        assert_eq!(
            overcap_display_percent(Some(1000.0), Some(1000)),
            Some(100.0)
        );
        // 3x over cap => 300%.
        assert_eq!(
            overcap_display_percent(Some(3000.0), Some(1000)),
            Some(300.0)
        );
        // Below cap => under 100%.
        assert_eq!(overcap_display_percent(Some(500.0), Some(1000)), Some(50.0));
    }

    #[test]
    fn overcap_percent_none_without_usable_inputs() {
        assert_eq!(overcap_display_percent(None, Some(1000)), None);
        assert_eq!(overcap_display_percent(Some(1500.0), None), None);
        assert_eq!(overcap_display_percent(Some(1500.0), Some(0)), None);
        assert_eq!(overcap_display_percent(Some(f32::NAN), Some(1000)), None);
    }
}
