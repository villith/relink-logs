//! Crit-aware damage-cap detection.
//!
//! The game reports `final_damage = min(raw_base, damage_cap) * crit_multiplier`.
//! So a hit is capped when its base was clamped to the cap; the reported `damage`
//! then equals `cap * m` for one of the encounter's crit multipliers `m` (>= 1.0).
//! `damage > cap` is normal (a capped base that then crit). The naive `damage >= cap`
//! rule misfires only on uncapped hits whose `base * crit` slightly exceeds the cap;
//! those land BETWEEN the discrete crit peaks, so requiring a match to a learned
//! multiplier removes them.
//!
//! See the `gbfr-damage-cap-model` notes for the reverse-engineering evidence.

/// Learn the set of crit multipliers for an encounter from the hits whose damage
/// reached or exceeded their cap. The multipliers are the recurring `damage/cap`
/// ratios (>= ~1.0). Returned sorted ascending.
///
/// `at_or_over_cap` yields `(damage, cap)` for every hit with `cap > 0` and
/// `damage >= cap`.
pub fn learn_crit_multipliers(at_or_over_cap: impl Iterator<Item = (i32, i32)>) -> Vec<f64> {
    use std::collections::BTreeMap;

    // Fine bucket (0.002) so distinct multipliers like 1.188 are not merged into a
    // coarse 0.01 bucket whose center would then mispredict cap*m.
    const BUCKET: f64 = 0.002;
    let mut counts: BTreeMap<i64, u64> = BTreeMap::new();
    let mut total: u64 = 0;
    for (damage, cap) in at_or_over_cap {
        if cap <= 0 || damage < cap {
            continue;
        }
        let ratio = damage as f64 / cap as f64;
        *counts.entry((ratio / BUCKET).round() as i64).or_default() += 1;
        total += 1;
    }
    if total == 0 {
        return Vec::new();
    }
    // A multiplier "peak" must hold at least 1% of at/over-cap hits (min 3) to be
    // considered real rather than a near-cap uncapped-crit coincidence.
    let threshold = (total / 100).max(3);
    counts
        .into_iter()
        .filter(|(_, c)| *c >= threshold)
        .map(|(b, _)| b as f64 * BUCKET)
        .collect()
}

/// Is this hit capped, given the encounter's learned crit multipliers?
///
/// True when `damage >= cap > 0` AND `damage` is (within relative tolerance) equal
/// to `cap * m` for one of the `crit_multipliers`. If no multipliers were learned
/// (e.g. too little data), falls back to the simple `damage >= cap` rule.
pub fn is_capped(damage: i32, cap: Option<i32>, crit_multipliers: &[f64]) -> bool {
    let Some(cap) = cap else { return false };
    if cap <= 0 || damage < cap {
        return false;
    }
    if crit_multipliers.is_empty() {
        return true; // fallback: simple rule
    }
    // Relative tolerance (0.3% of damage, >= 2) absorbs the game's integer rounding
    // and the peak quantization on large caps.
    let tol = (0.003 * damage as f64).max(2.0);
    crit_multipliers
        .iter()
        .any(|&m| (cap as f64 * m - damage as f64).abs() <= tol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learns_recurring_crit_multipliers() {
        // cap 1000; many hits at x1.0, x1.2, x1.32; a couple of stray near-cap values.
        let mut data = Vec::new();
        for _ in 0..50 {
            data.push((1000, 1000)); // x1.0
            data.push((1200, 1000)); // x1.2
            data.push((1320, 1000)); // x1.32
        }
        data.push((1037, 1000)); // x1.037 stray (uncapped-crit), below 1% support
        data.push((1041, 1000));

        let mults = learn_crit_multipliers(data.into_iter());
        // Should contain ~1.0, ~1.2, ~1.32 and NOT the strays.
        assert!(mults.iter().any(|m| (m - 1.0).abs() < 0.01));
        assert!(mults.iter().any(|m| (m - 1.2).abs() < 0.01));
        assert!(mults.iter().any(|m| (m - 1.32).abs() < 0.01));
        assert!(!mults.iter().any(|m| (m - 1.037).abs() < 0.005));
    }

    #[test]
    fn capped_when_damage_matches_a_crit_multiple() {
        let mults = vec![1.0, 1.2, 1.32];
        // Exactly at cap -> capped.
        assert!(is_capped(1000, Some(1000), &mults));
        // Capped base then x1.2 crit -> capped (damage > cap, on a peak).
        assert!(is_capped(1200, Some(1000), &mults));
        // x1.32 with integer rounding (1319 ~ 1320) -> capped.
        assert!(is_capped(1319, Some(1000), &mults));
    }

    #[test]
    fn not_capped_when_between_crit_peaks() {
        let mults = vec![1.0, 1.2, 1.32];
        // damage >= cap but ratio 1.08 is BETWEEN peaks -> an uncapped near-cap crit.
        assert!(!is_capped(1080, Some(1000), &mults));
    }

    #[test]
    fn not_capped_for_sentinels_and_under_cap() {
        let mults = vec![1.0, 1.2];
        assert!(!is_capped(500, Some(1000), &mults)); // under cap
        assert!(!is_capped(9999, Some(-1), &mults)); // sentinel cap
        assert!(!is_capped(9999, Some(0), &mults)); // zero cap
        assert!(!is_capped(9999, None, &mults)); // no cap info
    }

    #[test]
    fn falls_back_to_simple_rule_without_multipliers() {
        // No learned multipliers (e.g. sparse data) -> damage >= cap.
        assert!(is_capped(1000, Some(1000), &[]));
        assert!(is_capped(1500, Some(1000), &[]));
        assert!(!is_capped(900, Some(1000), &[]));
    }
}
