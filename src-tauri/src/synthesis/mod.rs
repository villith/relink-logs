//! Sigil Synthesis prediction engine.
//!
//! Pure port of the game's synthesis algorithm (v2.0.2, reverse-engineered —
//! see docs/superpowers/specs/2026-07-18-synthesis-helper-design.md). The
//! hook takes the input snapshot in-process (game-reader crate, served over
//! the toolbox RPC channel); everything here is deterministic and
//! unit-testable.

use serde::{Deserialize, Serialize};

pub use game_reader::xorshift32;
/// The game's "no trait in this slot" sentinel.
pub use game_reader::EMPTY_KEY as EMPTY_TRAIT;
pub use protocol::toolbox::{SynthesisSeed, SynthesisSigil, SynthesisSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub trait1: u32,
    pub trait2: Option<u32>,
    /// true = the weighted roll hit the upgraded (level-15) outcome.
    pub lucky: bool,
}

fn trait_sum(s: &SynthesisSigil) -> u64 {
    let t1 = if s.trait1 == EMPTY_TRAIT {
        0
    } else {
        s.trait1 as u64
    };
    let t2 = if s.trait2 == EMPTY_TRAIT {
        0
    } else {
        s.trait2 as u64
    };
    t1 + t2
}

fn rank(s: &SynthesisSigil) -> u32 {
    let l1 = if s.trait1 == EMPTY_TRAIT {
        0
    } else {
        s.trait1_level
    };
    let l2 = if s.trait2 == EMPTY_TRAIT {
        0
    } else {
        s.trait2_level
    };
    l1.wrapping_add(l2)
}

/// Predict the result of synthesizing `a` + `b` under `snap`'s RNG state.
///
/// Precondition: at least one of the four trait slots is non-empty (every
/// real sigil has a first trait). Two fully-blank sigils would make the
/// candidate list empty.
pub fn predict(snap: &SynthesisSnapshot, a: &SynthesisSigil, b: &SynthesisSigil) -> Prediction {
    let pair_key =
        trait_sum(a) + trait_sum(b) + (a.record_level.wrapping_add(b.record_level) as u32) as u64;
    let n = snap
        .pair_counters
        .get(&pair_key)
        .copied()
        .unwrap_or(0)
        .wrapping_add(1);
    let warm = (n.wrapping_mul(9) as u64)
        .wrapping_add(pair_key)
        .wrapping_add(snap.seed_counter as u64)
        % 1000;

    let mut s = snap.rng_state;
    for _ in 0..warm {
        s = xorshift32(s);
    }

    let (lo, hi) = snap
        .level_weights
        .get(&rank(a).wrapping_add(rank(b)))
        .copied()
        .unwrap_or((0, 0));
    s = xorshift32(s); // the level roll always draws, even with no weights
    let weight_total = lo.wrapping_add(hi);
    let lucky = weight_total > 0 && (s % weight_total) >= lo;

    let mut cand: Vec<u32> = [a.trait1, a.trait2, b.trait1, b.trait2]
        .into_iter()
        .filter(|&t| t != EMPTY_TRAIT)
        .collect();
    cand.sort_unstable();
    let len = cand.len();
    for i in 0..len {
        s = xorshift32(s);
        let rem = (len - i) as u32;
        let mut r = s;
        if r >= rem {
            r %= rem;
        }
        cand.swap(i, i + r as usize);
    }

    debug_assert!(
        !cand.is_empty(),
        "predict() called with two traitless sigils"
    );

    Prediction {
        trait1: cand[0],
        trait2: cand.get(1).copied(),
        lucky,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisQuery {
    pub trait1: u32,
    pub trait2: Option<u32>,
    pub any_order: bool,
    pub require_lucky: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisMatch {
    pub sigil_a: SynthesisSigil,
    pub sigil_b: SynthesisSigil,
    pub prediction: Prediction,
    /// Item id of the result sigil (for display), when known.
    pub result_sigil_id: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisStatus {
    pub game_running: bool,
    pub sigil_count: u32,
    /// True when RNG state is 0 (the game will reseed from entropy — unpredictable).
    pub rng_unpredictable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSearchResponse {
    pub matches: Vec<SynthesisMatch>,
    pub pairs_tested: u64,
    pub sigil_count: u32,
    pub rng_unpredictable: bool,
    /// Seed identity the search was computed from; when the live values move
    /// off these, the result list is stale.
    pub rng_state: u32,
    pub seed_counter: u32,
}

/// Item ids of "special" sigils the game refuses as synthesis material
/// (character sigils, single-trait uniques). Baked from gem.tbl's special
/// flag by scripts/gen-synthesis-excluded-sigils.py.
fn excluded_sigils() -> &'static std::collections::HashSet<u32> {
    static SET: std::sync::OnceLock<std::collections::HashSet<u32>> = std::sync::OnceLock::new();
    SET.get_or_init(|| {
        serde_json::from_str::<Vec<String>>(include_str!(
            "../../assets/synthesis-excluded-sigils.json"
        ))
        .expect("synthesis-excluded-sigils.json is a JSON string array")
        .into_iter()
        .map(|s| {
            u32::from_str_radix(&s, 16).expect("synthesis-excluded-sigils.json entries are hex ids")
        })
        .collect()
    })
}

/// A sigil can be used in synthesis iff it has two real traits, both at level
/// 11 or higher, and it is not a "special" sigil (gem.tbl flag; see
/// `excluded_sigils`). Level rule confirmed live (2026-07-18).
pub fn is_eligible(s: &SynthesisSigil) -> bool {
    s.trait1 != EMPTY_TRAIT
        && s.trait2 != EMPTY_TRAIT
        && s.trait1_level >= 11
        && s.trait2_level >= 11
        && !excluded_sigils().contains(&s.sigil_id)
}

/// The prediction-relevant identity of a sigil. Two sigils with the same key
/// always synthesize identically (the instance uid does not affect the result,
/// confirmed live), so search() collapses them to one representative.
fn dedup_key(s: &SynthesisSigil) -> (u32, u32, u32, u32, i32) {
    (
        s.trait1,
        s.trait1_level,
        s.trait2,
        s.trait2_level,
        s.record_level,
    )
}

/// A sigil's display level: eligible sigils have two real traits, whose
/// levels are equal in practice; take the max so a mixed pair still sorts
/// sensibly. Feeds the cheapest-materials-first result order.
fn sigil_level(s: &SynthesisSigil) -> u32 {
    s.trait1_level.max(s.trait2_level)
}

/// Test every unordered pair of ELIGIBLE, distinct-identity sigils whose
/// combined traits could contain the queried ones; return (all matches,
/// sorted by lowest input sigil levels first, and the pair count actually
/// predicted).
pub fn search(snap: &SynthesisSnapshot, q: &SynthesisQuery) -> (Vec<SynthesisMatch>, u64) {
    let has = |s: &SynthesisSigil, t: u32| s.trait1 == t || s.trait2 == t;
    let wanted = |p: &Prediction| -> bool {
        if q.require_lucky && !p.lucky {
            return false;
        }
        match q.trait2 {
            None => p.trait1 == q.trait1 || (q.any_order && p.trait2 == Some(q.trait1)),
            Some(t2) => {
                let exact = p.trait1 == q.trait1 && p.trait2 == Some(t2);
                let swapped = p.trait1 == t2 && p.trait2 == Some(q.trait1);
                exact || (q.any_order && swapped)
            }
        }
    };

    // Only eligible sigils can be synthesized, and identical-identity copies
    // predict the same result, so collapse them to one representative each.
    let mut seen = std::collections::HashSet::new();
    let pool: Vec<&SynthesisSigil> = snap
        .sigils
        .iter()
        .filter(|s| is_eligible(s))
        .filter(|s| seen.insert(dedup_key(s)))
        .collect();

    let mut matches = Vec::new();
    let mut tested = 0u64;
    for i in 0..pool.len() {
        for j in (i + 1)..pool.len() {
            let (a, b) = (pool[i], pool[j]);
            if !has(a, q.trait1) && !has(b, q.trait1) {
                continue;
            }
            if let Some(t2) = q.trait2 {
                if !has(a, t2) && !has(b, t2) {
                    continue;
                }
            }
            tested += 1;
            let p = predict(snap, a, b);
            if wanted(&p) {
                matches.push(SynthesisMatch {
                    sigil_a: a.clone(),
                    sigil_b: b.clone(),
                    prediction: p,
                    result_sigil_id: snap.trait_to_item.get(&p.trait1).copied(),
                });
            }
        }
    }
    // Cheapest materials first: (11,11) pairs, then (11,15), then (15,15).
    // Stable, so equal-level pairs keep discovery order.
    matches.sort_by_key(|m| {
        let (la, lb) = (sigil_level(&m.sigil_a), sigil_level(&m.sigil_b));
        (la.min(lb), la.max(lb))
    });
    (matches, tested)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sigil(uid: u32, t1: u32, l1: u32, t2: u32, l2: u32, rec: i32) -> SynthesisSigil {
        SynthesisSigil {
            uid,
            sigil_id: 0,
            trait1: t1,
            trait1_level: l1,
            trait2: t2,
            trait2_level: l2,
            record_level: rec,
        }
    }

    /// Reference sequence computed independently from the decompiled
    /// algorithm: s=1 -> 0x1000a001, 0x45000201, 0x451080a1, 0x10150a23, ...
    #[test]
    fn xorshift32_reference_sequence() {
        let mut s = 1u32;
        let expect = [
            0x1000a001u32,
            0x45000201,
            0x451080a1,
            0x10150a23,
            0x2814b28b,
        ];
        for e in expect {
            s = xorshift32(s);
            assert_eq!(s, e);
        }
    }

    /// Full predict() against an independently computed fixture:
    /// A = {t 0x100 l11, t 0x200 l15, rec 5}, B = {t 0x300 l12, empty, rec 7}
    /// pair_key = 0x100+0x200+0x300+(5+7) = 1548; counters empty -> n=1;
    /// seed_counter = 42 -> warm = (9+1548+42) % 1000 = 599.
    /// rng_state = 123456789; weights {38: (3,7)}.
    /// Expected (Python reference): lucky = true, result = [0x300, 0x200] (0x100 last).
    #[test]
    fn predict_reference_fixture() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        snap.level_weights.insert(38, (3, 7));
        let p = predict(&snap, &a, &b);
        assert_eq!(p.trait1, 0x300);
        assert_eq!(p.trait2, Some(0x200));
        assert!(p.lucky);
    }

    /// The algorithm only sums the two sigils' contributions — order must not matter.
    #[test]
    fn predict_is_symmetric() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, 0x400, 3, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 0xdead_beef,
            seed_counter: 7,
            ..Default::default()
        };
        snap.level_weights.insert(41, (10, 1));
        assert_eq!(predict(&snap, &a, &b), predict(&snap, &b, &a));
    }

    /// Missing weight entry (or lo+hi == 0) can never be lucky, but the level
    /// draw still advances the stream before the shuffle.
    #[test]
    fn predict_no_weights_is_never_lucky() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        let p = predict(&snap, &a, &b);
        assert!(!p.lucky);
        // Same draws as the reference fixture -> same shuffle outcome.
        assert_eq!(p.trait1, 0x300);
        assert_eq!(p.trait2, Some(0x200));
    }

    /// A pair counter shifts the warm-up by 9 per prior synthesis.
    #[test]
    fn predict_pair_counter_changes_warmup() {
        let a = sigil(0xA, 0x100, 11, 0x200, 15, 5);
        let b = sigil(0xB, 0x300, 12, EMPTY_TRAIT, 0, 7);
        let mut snap = SynthesisSnapshot {
            rng_state: 123_456_789,
            seed_counter: 42,
            ..Default::default()
        };
        let base = predict(&snap, &a, &b);
        snap.pair_counters.insert(1548, 3); // n becomes 4 -> warm = 626 instead of 599
        let shifted = predict(&snap, &a, &b);
        assert_ne!(base, shifted);
        // Python reference for warm=626: result [0x200, 0x300, 0x100]
        assert_eq!(shifted.trait1, 0x200);
        assert_eq!(shifted.trait2, Some(0x300));
    }

    /// Two eligible sigils A(0x100,0x300) + B(0x200,0x400), all traits lvl 11,
    /// at rng 987654321 seed 42 -> predict() = (0x200, 0x300) not lucky
    /// (independent Python reference). trait_to_item maps the slot-1 trait.
    fn search_snap() -> SynthesisSnapshot {
        let mut snap = SynthesisSnapshot {
            rng_state: 987_654_321,
            seed_counter: 42,
            ..Default::default()
        };
        snap.trait_to_item.insert(0x200, 0x9999);
        snap.sigils = vec![
            sigil(1, 0x100, 11, 0x300, 11, 5),
            sigil(2, 0x200, 11, 0x400, 11, 7),
        ];
        snap
    }

    /// The one eligible pair (1,2) predicts (0x200, 0x300).
    #[test]
    fn search_finds_matching_pair() {
        let snap = search_snap();
        let q = SynthesisQuery {
            trait1: 0x200,
            trait2: Some(0x300),
            any_order: false,
            require_lucky: false,
        };
        let (matches, tested) = search(&snap, &q);
        assert_eq!(tested, 1);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].sigil_a.uid, 1);
        assert_eq!(matches[0].sigil_b.uid, 2);
        assert_eq!(matches[0].result_sigil_id, Some(0x9999));
    }

    /// "Special" sigils (character sigils, single-trait uniques — flagged in
    /// gem.tbl, baked into synthesis-excluded-sigils.json) can never be
    /// synthesis material, even with two level-11+ traits. 0xDA9136A1 is
    /// War Elemental; 0x936DFE00 is Fearless Spirit.
    #[test]
    fn special_sigils_are_not_eligible() {
        let mut s = sigil(1, 0x100, 11, 0x300, 11, 5);
        assert!(is_eligible(&s));
        s.sigil_id = 0xDA9136A1;
        assert!(!is_eligible(&s));
        s.sigil_id = 0x936DFE00;
        assert!(!is_eligible(&s));
    }

    /// A special sigil in the box is never paired by search().
    #[test]
    fn search_skips_special_sigils() {
        let mut snap = search_snap();
        // Same traits as eligible sigil 1, but carrying War Elemental's item id.
        let mut special = sigil(3, 0x100, 11, 0x300, 11, 5);
        special.sigil_id = 0xDA9136A1;
        // Distinct record_level so dedup can't be what hides it.
        special.record_level = 6;
        snap.sigils.push(special);
        let q = SynthesisQuery {
            trait1: 0x200,
            trait2: None,
            any_order: true,
            require_lucky: false,
        };
        let (_m, tested) = search(&snap, &q);
        // Only the (1,2) pair — the special sigil joins no pair.
        assert_eq!(tested, 1);
    }

    /// Ineligible sigils (1-trait or below level 11) are never paired.
    #[test]
    fn search_skips_ineligible_sigils() {
        let mut snap = search_snap();
        // A 1-trait sigil and a below-level-11 2-trait sigil; neither is usable.
        snap.sigils.push(sigil(3, 0x200, 15, EMPTY_TRAIT, 0, 9));
        snap.sigils.push(sigil(4, 0x100, 10, 0x400, 11, 9)); // trait1 below 11
        let q = SynthesisQuery {
            trait1: 0x200,
            trait2: None,
            any_order: true,
            require_lucky: false,
        };
        let (_m, tested) = search(&snap, &q);
        // Only the single eligible pair (1,2) is ever predicted.
        assert_eq!(tested, 1);
    }

    /// Identical-identity copies collapse to one representative (uid ignored).
    #[test]
    fn search_dedups_identical_sigils() {
        let mut snap = search_snap();
        // Three extra copies of sigil 1 (same traits/levels/rec, different uid).
        snap.sigils.push(sigil(10, 0x100, 11, 0x300, 11, 5));
        snap.sigils.push(sigil(11, 0x100, 11, 0x300, 11, 5));
        snap.sigils.push(sigil(12, 0x100, 11, 0x300, 11, 5));
        let q = SynthesisQuery {
            trait1: 0x200,
            trait2: Some(0x300),
            any_order: false,
            require_lucky: false,
        };
        let (matches, tested) = search(&snap, &q);
        // Still just one distinct pair, one match — not four.
        assert_eq!(tested, 1);
        assert_eq!(matches.len(), 1);
    }

    /// Exact order excludes the swapped outcome; any_order accepts it.
    #[test]
    fn search_order_toggle() {
        let snap = search_snap();
        let exact = SynthesisQuery {
            trait1: 0x300,
            trait2: Some(0x200),
            any_order: false,
            require_lucky: false,
        };
        let (m, _) = search(&snap, &exact);
        assert!(m.is_empty());
        let any = SynthesisQuery {
            trait1: 0x300,
            trait2: Some(0x200),
            any_order: true,
            require_lucky: false,
        };
        let (m, _) = search(&snap, &any);
        assert_eq!(m.len(), 1);
    }

    /// require_lucky filters out normal rolls (fixture has no weights -> never lucky).
    #[test]
    fn search_require_lucky() {
        let snap = search_snap();
        let q = SynthesisQuery {
            trait1: 0x200,
            trait2: Some(0x300),
            any_order: false,
            require_lucky: true,
        };
        let (m, _) = search(&snap, &q);
        assert!(m.is_empty());
    }

    /// Reference vector for the 4-candidate shuffle with a DUPLICATED trait
    /// (duplicates must be kept): A = {0x100 l5, 0x300 l10, rec 2},
    /// B = {0x300 l12, 0x400 l1, rec 3}; pair_key = 2821, seed 100 -> warm 930;
    /// rng 987654321; ranksum 28, weights {28: (2,5)}.
    /// Python reference: lucky = true, shuffled = [0x400, 0x300, 0x300, 0x100].
    #[test]
    fn predict_four_candidates_with_duplicate() {
        let a = sigil(0xA, 0x100, 5, 0x300, 10, 2);
        let b = sigil(0xB, 0x300, 12, 0x400, 1, 3);
        let mut snap = SynthesisSnapshot {
            rng_state: 987_654_321,
            seed_counter: 100,
            ..Default::default()
        };
        snap.level_weights.insert(28, (2, 5));
        let p = predict(&snap, &a, &b);
        assert_eq!(p.trait1, 0x400);
        assert_eq!(p.trait2, Some(0x300));
        assert!(p.lucky);
    }

    /// Matches are sorted cheapest-materials-first: by the pair's input sigil
    /// levels, (11,11) before (11,15) before (15,15). Levels don't feed the
    /// warm-up (only trait sums + record levels do), so this reuses the
    /// all-three-pairs-match fixture with levels varied.
    #[test]
    fn search_sorts_matches_by_input_levels() {
        let mut snap = SynthesisSnapshot {
            rng_state: 3,
            seed_counter: 1,
            ..Default::default()
        };
        snap.sigils = vec![
            sigil(1, 0x100, 15, 0x110, 15, 1),
            sigil(2, 0x100, 11, 0x120, 11, 1),
            sigil(3, 0x100, 15, 0x130, 15, 1),
        ];
        let q = SynthesisQuery {
            trait1: 0x100,
            trait2: None,
            any_order: false,
            require_lucky: false,
        };
        let (matches, _) = search(&snap, &q);
        assert_eq!(matches.len(), 3);
        // Discovery order is (1,2),(1,3),(2,3); level keys (11,15),(15,15),(11,15).
        // Sorted: (1,2) then (2,3) then (1,3).
        let uids: Vec<(u32, u32)> = matches
            .iter()
            .map(|m| (m.sigil_a.uid, m.sigil_b.uid))
            .collect();
        assert_eq!(uids, vec![(1, 2), (2, 3), (1, 3)]);
    }
}
