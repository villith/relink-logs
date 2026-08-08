//! Cross-hit consistency, which is the only falsifiable check available.
//!
//! `base_cap` is recovered by dividing the logged cap by the modelled
//! multiplier, so it agrees with the game by construction on any single hit.
//! It cannot agree across hits unless the model is right: the base is a
//! function of attack rate alone, so every hit at one rate must imply the same
//! base. The spread of those implied bases is the model's real error.

/// The relative spread of implied base caps among hits sharing `rate`.
///
/// `0.0` when fewer than two hits share the rate — one observation cannot
/// disagree with itself, and reporting a spread there would invent confidence.
pub fn rate_residual(observed: &[(f32, f64)], rate: f32) -> f64 {
    let bases: Vec<f64> = observed
        .iter()
        .filter(|(r, _)| *r == rate)
        .map(|(_, base)| *base)
        .filter(|b| b.is_finite() && *b > 0.0)
        .collect();
    if bases.len() < 2 {
        return 0.0;
    }
    let lo = bases.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = bases.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if lo <= 0.0 {
        return 0.0;
    }
    hi / lo - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agreeing_hits_at_one_rate_have_no_residual() {
        // Two hits, same rate, different players: their implied bases agree, so
        // the model explains the difference in their caps entirely.
        let observed = [(1.4_f32, 20_000.0_f64), (1.4, 20_000.0)];
        assert!(rate_residual(&observed, 1.4).abs() < 1e-9);
    }

    #[test]
    fn disagreeing_hits_report_the_relative_spread() {
        // 5% apart: a term the model is missing varies between these hits.
        let observed = [(1.4_f32, 20_000.0_f64), (1.4, 21_000.0)];
        assert!((rate_residual(&observed, 1.4) - 0.05).abs() < 1e-6);
    }

    #[test]
    fn a_rate_with_one_observation_cannot_disagree_with_itself() {
        let observed = [(1.4_f32, 20_000.0_f64)];
        assert_eq!(rate_residual(&observed, 1.4), 0.0);
    }
}
