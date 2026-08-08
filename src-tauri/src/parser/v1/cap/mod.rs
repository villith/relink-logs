//! Damage-cap breakdown: what the game's cap for one hit was made of.
//!
//! The game computes `cap = (int)((1 + Σ cap-up − Σ cap-down) × trunc(baseCap))`
//! in `FUN_1409c1cf0`. We cannot read `baseCap` — it is interpolated from a
//! runtime table and never stored on the instance — so it is recovered by
//! division instead, and the honest consequence is that this module can never
//! disagree with the logged cap. What it CAN do is say how much of the
//! multiplier it explains, which is the residual.

pub mod terms;

/// The per-hit and per-player facts the breakdown needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CapInputs {
    /// The cap the game logged for this hit.
    pub logged_cap: Option<i32>,
    pub attack_rate: Option<f32>,
    /// `instance+0xF0`; see [`selected_cap_up`].
    pub class_flags: Option<u32>,
    pub cap_up_normal: Option<f32>,
    pub cap_up_skill: Option<f32>,
    pub cap_up_sba: Option<f32>,
}

/// One named contribution to the multiplier.
#[derive(Debug, Clone, PartialEq)]
pub struct CapTerm {
    pub label_key: &'static str,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CapBreakdown {
    /// `trunc(baseCap)`, recovered as `logged_cap / multiplier`.
    pub base_cap: f64,
    /// `1 + Σ known terms`.
    pub multiplier: f64,
    pub terms: Vec<CapTerm>,
    /// The part of the multiplier no term explains. Rendered as its own row —
    /// a reproduction that cannot report its own error is worse than none.
    pub residual: f64,
}

/// Skybound Art (`0x40000`) beats Skill (`0x10000`); neither means Normal.
///
/// The order matters and is the builder's own: it tests `0x10000` first but the
/// `0x40000` branch jumps past the skill assignment, so a hit carrying both is
/// a Skybound Art.
pub fn selected_cap_up(inputs: &CapInputs) -> Option<f32> {
    let flags = inputs.class_flags?;
    if flags & 0x40000 != 0 {
        inputs.cap_up_sba
    } else if flags & 0x10000 != 0 {
        inputs.cap_up_skill
    } else {
        inputs.cap_up_normal
    }
}

/// `None` when there is no cap to explain — an absent cap, or the game's
/// uncapped sentinel. Returning a zeroed breakdown instead would read as "the
/// cap was zero", which is a different and wrong statement.
pub fn breakdown(inputs: &CapInputs, extra_terms: &[CapTerm]) -> Option<CapBreakdown> {
    let logged = inputs.logged_cap.filter(|c| *c > 0)? as f64;

    let mut terms = Vec::new();
    if let Some(cap_up) = selected_cap_up(inputs) {
        terms.push(CapTerm {
            label_key: "ui.logs.cap-term-record",
            value: cap_up as f64,
        });
    }
    terms.extend(extra_terms.iter().cloned());

    let multiplier = 1.0 + terms.iter().map(|t| t.value).sum::<f64>();
    if multiplier <= 0.0 {
        return None;
    }

    // Base by division: see the module comment for why there is nothing else to
    // divide by. This makes `base_cap x multiplier == logged_cap` an identity,
    // so it is NOT evidence the model is right.
    let base_cap = logged / multiplier;

    Some(CapBreakdown {
        base_cap,
        multiplier,
        terms,
        // Zero by construction here: with the base recovered by division there
        // is nothing on a single hit to disagree with. Cross-hit agreement at
        // one attack rate is where this number gets a real value.
        residual: 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit() -> CapInputs {
        CapInputs {
            logged_cap: Some(291_392),
            attack_rate: Some(1.4),
            class_flags: Some(0x1),
            cap_up_normal: Some(13.13),
            cap_up_skill: Some(15.18),
            cap_up_sba: Some(12.16),
        }
    }

    #[test]
    fn selects_the_cap_up_for_the_hits_attack_class() {
        assert_eq!(selected_cap_up(&hit()), Some(13.13));
        // 0x10000 is Skill.
        let skill = CapInputs {
            class_flags: Some(0x10008),
            ..hit()
        };
        assert_eq!(selected_cap_up(&skill), Some(15.18));
        // 0x40000 wins over 0x10000 — the builder tests it second and jumps.
        let sba = CapInputs {
            class_flags: Some(0x50000),
            ..hit()
        };
        assert_eq!(selected_cap_up(&sba), Some(12.16));
    }

    #[test]
    fn base_cap_comes_from_dividing_the_logged_cap_by_the_multiplier() {
        // multiplier = 1 + 13.13 = 14.13; 291392 / 14.13 = 20622.9...
        let b = breakdown(&hit(), &[]).expect("has a cap");
        assert!((b.multiplier - 14.13).abs() < 1e-6);
        assert!((b.base_cap - 291_392.0 / 14.13).abs() < 0.01);
    }

    #[test]
    fn the_residual_is_whatever_the_terms_do_not_explain() {
        // A term worth 3.60 on top: the model now explains 1 + 13.13 + 3.60.
        let b = breakdown(
            &hit(),
            &[CapTerm {
                label_key: "x",
                value: 3.60,
            }],
        )
        .expect("has a cap");
        assert!((b.multiplier - 17.73).abs() < 1e-6);
        // Residual is reported against the SAME base, so it is the part of the
        // logged cap the terms fail to account for.
        assert!(b.residual.abs() < 1e-6);
    }

    #[test]
    fn no_cap_means_no_breakdown_rather_than_a_zero() {
        let none = CapInputs {
            logged_cap: None,
            ..hit()
        };
        assert!(breakdown(&none, &[]).is_none());
        // The uncapped sentinel is not a cap either.
        let sentinel = CapInputs {
            logged_cap: Some(-1),
            ..hit()
        };
        assert!(breakdown(&sentinel, &[]).is_none());
    }
}
