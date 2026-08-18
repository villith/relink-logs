//! Scores a DMGHEAD oracle capture (hookdiag round) against the damage-head
//! factorization derived in the 2026-08-14 RE spike.
//!
//! Input: a slice of `gbfr-logs.txt` containing DMGHEAD / DMGREC / DMGDIAG
//! lines (the dev hook emits all three; DMGDIAG covers the first 500 hits per
//! injection). Round 1 (2026-08-14) established what each line actually holds:
//!
//!   - DMGHEAD fires at build time; `ret44920` is the builder's d4 BEFORE
//!     variance, `ret43670` the attack chain inside it. DMGREC follows with
//!     the same `inst`.
//!   - DMGDIAG fires AFTER ProcessDamageEvent: `unk@d0` still holds the
//!     builder's d0 (pre-variance), but `dmg@d4` is the FINAL damage
//!     (post-clamp, post-cap-chain) and `precap@2d4` the pre-clamp value —
//!     i.e. `builder d4 × variance × elemental`. The elemental multiplier
//!     itself is in the dump as `[0x2c8]` (f32 bits) with the relation enum
//!     at `[0x2c4]`.
//!
//! Joining: nearest following DMGDIAG with the same action id AND the same
//! `flags@e8` (the flag word differs per target, which disambiguates
//! alternating multi-target hits).
//!
//! Checks:
//!   1. d0 identity: non-crit hits must satisfy `d0 == trunc(ret43670 × mv)`
//!      exactly (f32); crit hits yield `critMult = d0 / (ret43670 × mv)`,
//!      clustered — must be stable per attacker loadout.
//!   2. class-ratio: `ret44920 / d0` must equal 1 for Normal-class hits and
//!      `1 + record.dmg_skill×0.01` for Skill-class hits (from the paired
//!      DMGREC). SBA hits get the record term + the party term — reported,
//!      not asserted, until the party term is captured.
//!   3. precap band: `precap@2d4 / trunc(ret44920)` must lie in
//!      `[elem, elem×1.05)` — variance is one-sided UP (`d4 += d4×0.05×r`,
//!      r ∈ [0,1)) — and equal `elem` exactly when the variance flags
//!      (`0x1000001000000` AND `0x100000000000`) are not both set.
//!   4. motion-value constancy: `mv_e0` grouped by action — constant ⇒ the
//!      +0xE0 slot is the authored per-action power ratio.
//!
//! Level-sync quests are excluded at capture time (checklist); they are never
//! modeled.
//!
//! Run: cargo run --release -p gbfr-logs --example dmg_head_check -- <capture.log>
//! Tests: cargo test -p gbfr-logs --example dmg_head_check   (DEBUG build —
//! the release test binary inherits the admin manifest and dies with os 740.)

use std::collections::BTreeMap;

/// Variance gate: BOTH flag masks must be set (builder decompile).
const VARIANCE_MASK_A: u64 = 0x1000001000000;
const VARIANCE_MASK_B: u64 = 0x100000000000;
/// Attack-class bits on `inst+0xF0`.
const CLASS_SKILL: u32 = 0x10000;
const CLASS_SBA: u32 = 0x40000;

#[derive(Debug, Clone, Default)]
struct HeadLine {
    inst: u64,
    action: u32,
    ret44920: f32,
    ret43670: f32,
    mv_e0: f32,
    class_flags: u32,
    flags: u64,
    /// bytes 0x15D..=0x167; [0] = is-crit.
    gates: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
struct RecLine {
    inst: u64,
    dmg_skill: f32,
    dmg_sba: f32,
    critdmg: f32,
}

#[derive(Debug, Clone, Default)]
struct DiagLine {
    d0: i64,
    precap: f64,
    action: u32,
    flags: u64,
    /// `[0x2c8]` from the dump — the elemental multiplier (f32 bits).
    elem: Option<f32>,
}

/// `key=value` extractor over a space-separated diag line. Values may carry
/// trailing commas/brackets; the numeric parsers below trim them.
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|tok| tok.strip_prefix(key))
        .map(|v| v.trim_end_matches(|c| c == ',' || c == ']'))
}

fn f32_field(line: &str, key: &str) -> Option<f32> {
    field(line, key)?.parse().ok()
}

fn u64_hex_field(line: &str, key: &str) -> Option<u64> {
    let v = field(line, key)?;
    u64::from_str_radix(v.trim_start_matches("0x"), 16).ok()
}

fn parse_dmghead_line(line: &str) -> Option<HeadLine> {
    if !line.contains("DMGHEAD ") {
        return None;
    }
    let gates = field(line, "gates=[")?
        .split(',')
        .filter_map(|b| u8::from_str_radix(b, 16).ok())
        .collect::<Vec<_>>();
    Some(HeadLine {
        inst: u64_hex_field(line, "inst=")?,
        action: field(line, "action=")?.parse().ok()?,
        ret44920: f32_field(line, "ret44920=")?,
        ret43670: f32_field(line, "ret43670=")?,
        mv_e0: f32_field(line, "mv_e0=")?,
        class_flags: u64_hex_field(line, "class_flags=")? as u32,
        flags: u64_hex_field(line, "flags=")?,
        gates,
    })
}

fn parse_dmgrec_line(line: &str) -> Option<RecLine> {
    if !line.contains("DMGREC ") {
        return None;
    }
    Some(RecLine {
        inst: u64_hex_field(line, "inst=")?,
        dmg_skill: f32_field(line, "dmg_skill=")?,
        dmg_sba: f32_field(line, "dmg_sba=")?,
        critdmg: f32_field(line, "critdmg=")?,
    })
}

fn parse_dmgdiag_line(line: &str) -> Option<DiagLine> {
    if !line.contains("DMGDIAG ") {
        return None;
    }
    let elem = field(line, "[0x2c8]=")
        .and_then(|v| v.parse::<u32>().ok())
        .map(f32::from_bits)
        .filter(|e| e.is_finite() && (0.01..100.0).contains(e));
    Some(DiagLine {
        d0: field(line, "unk@d0=")?.parse().ok()?,
        precap: field(line, "precap@2d4=")?.parse().ok()?,
        action: field(line, "action@16c=")?.parse().ok()?,
        flags: u64_hex_field(line, "flags@e8=")?,
        elem,
    })
}

/// d0 = trunc(ret43670 × critMult × mv). Non-crit ⇒ critMult 1 ⇒ exact check;
/// crit ⇒ return the implied multiplier for clustering.
fn score_d0(head: &HeadLine, diag: &DiagLine) -> Result<Option<f32>, (i64, i64)> {
    let base = head.ret43670 * head.mv_e0; // f32 mul, as the builder does
    let crit = head.gates.first().copied().unwrap_or(0) != 0;
    if !crit {
        let expect = base.trunc() as i64;
        if diag.d0 == expect {
            Ok(None)
        } else {
            Err((expect, diag.d0))
        }
    } else if base > 0.0 {
        Ok(Some(diag.d0 as f32 / base))
    } else {
        Ok(None)
    }
}

/// `ret44920 / d0` vs the class-selected record term. `None` = matches within
/// f32 division noise; `Some((expect, got))` = a factor the model is missing.
fn score_class_ratio(
    head: &HeadLine,
    diag: &DiagLine,
    rec: Option<&RecLine>,
) -> Option<(f32, f32)> {
    if diag.d0 <= 0 {
        return None;
    }
    let got = head.ret44920 / diag.d0 as f32;
    let expect = if head.class_flags & CLASS_SBA != 0 {
        // Record term + the party SBA term (uncaptured) — report only.
        return None;
    } else if head.class_flags & CLASS_SKILL != 0 {
        1.0 + rec?.dmg_skill * 0.01
    } else {
        1.0
    };
    // Division reintroduces rounding the builder never did (it multiplies);
    // 1e-4 relative is far below any real missing factor.
    if (got - expect).abs() <= expect * 1e-4 {
        None
    } else {
        Some((expect, got))
    }
}

#[derive(Debug, PartialEq)]
enum PrecapVerdict {
    /// Non-variance: precap == trunc(ret44920) × elem (to f32 store noise).
    Exact,
    /// Variance-flagged and inside [elem, elem×1.05).
    VarianceOk,
    /// Outside the band — missing branch or wrong elemental.
    Band(f32),
    /// No elemental in the dump — can't judge.
    NoElem,
}

fn score_precap(head: &HeadLine, diag: &DiagLine) -> PrecapVerdict {
    let Some(elem) = diag.elem else {
        return PrecapVerdict::NoElem;
    };
    let store = head.ret44920.trunc() as f64;
    if store <= 0.0 {
        return PrecapVerdict::NoElem;
    }
    let ratio = (diag.precap / store / elem as f64) as f32;
    // ANY bit of each mask — the builder tests `(flags & A) && (flags & B)`,
    // not full-mask equality.
    let variance = head.flags & VARIANCE_MASK_A != 0 && head.flags & VARIANCE_MASK_B != 0;
    if !variance {
        if (ratio - 1.0).abs() <= 1e-4 {
            PrecapVerdict::Exact
        } else {
            PrecapVerdict::Band(ratio)
        }
    } else if (1.0 - 1e-4..1.0500002).contains(&ratio) {
        PrecapVerdict::VarianceOk
    } else {
        PrecapVerdict::Band(ratio)
    }
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: dmg_head_check <capture.log>");
        std::process::exit(2);
    });
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    });

    let lines: Vec<&str> = text.lines().collect();
    let mut triples: Vec<(HeadLine, Option<RecLine>, DiagLine)> = Vec::new();
    let mut unjoined = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let Some(head) = parse_dmghead_line(line) else {
            continue;
        };
        let rec = lines[i + 1..]
            .iter()
            .take(4)
            .find_map(|l| parse_dmgrec_line(l).filter(|r| r.inst == head.inst));
        let joined = lines[i + 1..].iter().take(40).find_map(|l| {
            parse_dmgdiag_line(l).filter(|d| d.action == head.action && d.flags == head.flags)
        });
        match joined {
            Some(diag) => triples.push((head, rec, diag)),
            None => unjoined += 1,
        }
    }

    let mut d0_exact = 0usize;
    let mut d0_mismatch: Vec<(u32, i64, i64)> = Vec::new();
    let mut crit_mults: BTreeMap<u32, Vec<f32>> = BTreeMap::new(); // keyed by critdmg record ×100
    let mut ratio_ok = 0usize;
    let mut ratio_sba = 0usize;
    let mut ratio_mismatch: BTreeMap<(u32, String, u32), usize> = BTreeMap::new();
    let mut precap = BTreeMap::from([
        ("exact", 0usize),
        ("variance_ok", 0),
        ("band", 0),
        ("no_elem", 0),
    ]);
    let mut band_list: Vec<(u32, f32)> = Vec::new();
    let mut mv_by_action: BTreeMap<u32, Vec<f32>> = BTreeMap::new();

    for (head, rec, diag) in &triples {
        match score_d0(head, diag) {
            Ok(None) => d0_exact += 1,
            Ok(Some(mult)) => crit_mults
                .entry(
                    rec.as_ref()
                        .map(|r| (r.critdmg * 100.0) as u32)
                        .unwrap_or(0),
                )
                .or_default()
                .push(mult),
            Err((expect, got)) => d0_mismatch.push((head.action, expect, got)),
        }
        if head.class_flags & CLASS_SBA != 0 {
            ratio_sba += 1;
        } else {
            match score_class_ratio(head, diag, rec.as_ref()) {
                None => ratio_ok += 1,
                Some((_, got)) => {
                    let gates = head
                        .gates
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<Vec<_>>()
                        .join(",");
                    *ratio_mismatch
                        .entry((head.action, gates, (got * 100000.0).round() as u32))
                        .or_default() += 1;
                }
            }
        }
        match score_precap(head, diag) {
            PrecapVerdict::Exact => *precap.get_mut("exact").unwrap() += 1,
            PrecapVerdict::VarianceOk => *precap.get_mut("variance_ok").unwrap() += 1,
            PrecapVerdict::Band(r) => {
                *precap.get_mut("band").unwrap() += 1;
                band_list.push((head.action, r));
            }
            PrecapVerdict::NoElem => *precap.get_mut("no_elem").unwrap() += 1,
        }
        mv_by_action
            .entry(head.action)
            .or_default()
            .push(head.mv_e0);
    }

    println!("triples={} unjoined_heads={}", triples.len(), unjoined);
    println!(
        "d0: exact_noncrit={} crit_clustered={} mismatch={}",
        d0_exact,
        crit_mults.values().map(Vec::len).sum::<usize>(),
        d0_mismatch.len()
    );
    for (critdmg, mults) in &crit_mults {
        let (min, max) = mults
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), m| (a.min(*m), b.max(*m)));
        println!(
            "  crit cluster critdmg_rec={:.2}: n={} min={min:.5} max={max:.5}",
            *critdmg as f32 / 100.0,
            mults.len()
        );
    }
    println!(
        "class-ratio: ok={} sba_reported={} mismatch={}",
        ratio_ok,
        ratio_sba,
        ratio_mismatch.len()
    );
    println!("precap: {precap:?}");

    for (action, expect, got) in d0_mismatch.iter().take(20) {
        let off = (*got - *expect) as f64 / (*expect).max(1) as f64 * 100.0;
        println!("  WORKLIST d0 action={action} expect={expect} got={got} ({off:+.3}%)");
    }
    for ((action, gates, got_q), n) in ratio_mismatch.iter().take(30) {
        println!(
            "  WORKLIST class-ratio action={action} got={:.5} n={n} gates=[{gates}]",
            *got_q as f32 / 100000.0
        );
    }
    for (action, ratio) in band_list.iter().take(20) {
        println!("  WORKLIST precap action={action} ratio_over_elem={ratio:.5}");
    }

    let unstable: Vec<_> = mv_by_action
        .iter()
        .filter(|(_, vs)| {
            let (min, max) = vs
                .iter()
                .fold((f32::MAX, f32::MIN), |(a, b), m| (a.min(*m), b.max(*m)));
            vs.len() > 1 && (max - min) > f32::EPSILON * max.abs()
        })
        .collect();
    println!(
        "motion value: {} action groups, {} UNSTABLE (authored-constant hypothesis violated):",
        mv_by_action.len(),
        unstable.len()
    );
    for (action, vs) in unstable.iter().take(20) {
        let mut sorted = (*vs).clone();
        sorted.sort_by(f32::total_cmp);
        sorted.dedup();
        println!("  WORKLIST mv action={action} values={sorted:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "12:00:00 [INFO] DMGHEAD t=123 inst=0x7ff600 action=1700 \
        ret44920=1325054.25 ret43670=357871.3125 mv_e0=1.100000 d8=1.100000 rate_dc=1.100 \
        crit_rate=1.0800 class_flags=0x10008 flags=0x20000002130804 \
        gates=[01,01,00,00,00,01,00,00,01,00,01] elem_in=2";
    const REC: &str = "12:00:00 [INFO] DMGREC inst=0x7ff600 atk=133554 crit_base=108.000 \
        dmg_sba=20.000 dmg_skill=32.000 back=103.000 weak=53.000 critdmg=135.000 online=10.000";
    /// The diag fixture carries the elemental multiplier the way the live dump
    /// does — as the raw f32 bit pattern — so the bits are derived, not typed.
    fn diag_line() -> String {
        format!(
            "12:00:00 [INFO] DMGDIAG src_type=0x91418145 src_idx=2 unk@d0=1003829 \
             dmg@d4=380359 rate@d8=1.1 rate@dc=1.1 flags@e8=0x20000002130804 action@16c=1700 \
             floor@2b8=-1 cap@2bc=295541 precap@2d4=1533064 nonzero: [0xd0]=1003829 \
             [0x2c4]=1 [0x2c8]={}",
            1.15f32.to_bits()
        )
    }

    #[test]
    fn parses_all_three_lines() {
        let h = parse_dmghead_line(HEAD).expect("head");
        assert_eq!(h.action, 1700);
        assert_eq!(h.class_flags, 0x10008);
        assert_eq!(h.gates[0], 1);
        let r = parse_dmgrec_line(REC).expect("rec");
        assert_eq!(r.inst, h.inst);
        assert!((r.dmg_skill - 32.0).abs() < 1e-6);
        let d = parse_dmgdiag_line(&diag_line()).expect("diag");
        assert_eq!(d.flags, h.flags);
        assert_eq!(d.d0, 1003829);
        assert!((d.elem.unwrap() - 1.15).abs() < 1e-5);
        assert!(parse_dmghead_line("random noise").is_none());
    }

    #[test]
    fn crit_hit_yields_stable_multiplier() {
        let h = parse_dmghead_line(HEAD).unwrap();
        let d = parse_dmgdiag_line(&diag_line()).unwrap();
        // 1003829 / (357871.3125 × 1.1) = 2.55003…
        match score_d0(&h, &d) {
            Ok(Some(mult)) => assert!((mult - 2.55).abs() < 1e-3, "{mult}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn noncrit_d0_must_be_exact() {
        let head = HeadLine {
            ret43670: 1000.0,
            mv_e0: 2.5,
            gates: vec![0; 11],
            ..Default::default()
        };
        let diag = DiagLine {
            d0: 2500,
            ..Default::default()
        };
        assert_eq!(score_d0(&head, &diag), Ok(None));
        let off = DiagLine {
            d0: 2501,
            ..Default::default()
        };
        assert_eq!(score_d0(&head, &off), Err((2500, 2501)));
    }

    #[test]
    fn skill_class_ratio_matches_record_term() {
        let h = parse_dmghead_line(HEAD).unwrap();
        let r = parse_dmgrec_line(REC).unwrap();
        let d = parse_dmgdiag_line(&diag_line()).unwrap();
        // 1325054.25 / 1003829 = 1.32000… vs 1 + 32×0.01
        assert_eq!(score_class_ratio(&h, &d, Some(&r)), None);
        let wrong = RecLine {
            dmg_skill: 20.0,
            ..r
        };
        assert!(score_class_ratio(&h, &d, Some(&wrong)).is_some());
    }

    #[test]
    fn precap_band_is_variance_times_elemental() {
        // The sample hit's flags have BOTH variance masks clear, so precap
        // must equal store × elem exactly; anything else is Band and goes on
        // the worklist (that includes the real capture's ~0.6% residual —
        // measured, not excused).
        let h = parse_dmghead_line(HEAD).unwrap();
        let d = parse_dmgdiag_line(&diag_line()).unwrap();
        assert_eq!(h.flags & VARIANCE_MASK_A, 0);
        let exact = DiagLine {
            precap: 1325054.0 * 1.15,
            ..d.clone()
        };
        assert_eq!(score_precap(&h, &exact), PrecapVerdict::Exact);
        assert!(matches!(score_precap(&h, &d), PrecapVerdict::Band(_)));

        // With the variance bits set, the one-sided band applies.
        let vh = HeadLine {
            flags: VARIANCE_MASK_A | VARIANCE_MASK_B,
            ..h.clone()
        };
        let rolled = DiagLine {
            precap: 1325054.0 * 1.15 * 1.04,
            ..d.clone()
        };
        assert_eq!(score_precap(&vh, &rolled), PrecapVerdict::VarianceOk);
        let over = DiagLine {
            precap: 1325054.0 * 1.15 * 1.06,
            ..d.clone()
        };
        assert!(matches!(score_precap(&vh, &over), PrecapVerdict::Band(_)));
        let no_elem = DiagLine { elem: None, ..d };
        assert_eq!(score_precap(&h, &no_elem), PrecapVerdict::NoElem);
    }
}
