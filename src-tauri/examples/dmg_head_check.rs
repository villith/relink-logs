//! Scores a DMGHEAD oracle capture (hookdiag round) against the damage-head
//! factorization derived in the 2026-08-14 RE spike.
//!
//! Input: a slice of `gbfr-logs.txt` containing DMGHEAD / DMGREC / DMGDIAG
//! lines (the dev hook emits all three; DMGDIAG covers the first 500 hits per
//! injection). Each DMGHEAD line is joined to the nearest FOLLOWING DMGDIAG
//! line with the same action id — the builder runs synchronously inside the
//! hit's processing, so the pair belongs to one hit.
//!
//! What round 1 can prove (and what it cannot): the capture carries the two
//! head returns (`ret44920` = pre-variance d4, `ret43670` = the attack chain)
//! but not each individual factor, so this scorer verifies the STRUCTURE —
//! store exactness, the variance band, the crit multiplier's per-player
//! stability, motion-value constancy per action — and emits a worklist. A
//! full per-factor reproduction needs the factors captured separately; that
//! is a later round if the structure checks pass.
//!
//! Checks:
//!   1. store-exact: non-variance hits must satisfy `d4 == trunc(ret44920)`.
//!   2. variance band: variance-flagged hits must satisfy
//!      `d4 / trunc(ret44920) ∈ [1.0, 1.05)` (the roll is `d4 += d4×0.05×r`,
//!      r ∈ [0,1) — one-sided UP, never down).
//!   3. d0-exact: non-crit hits must satisfy `d0 == trunc(ret43670 × mv_e0)`
//!      (f32 arithmetic; the crit multiplier is 1 there).
//!   4. crit-mult clusters: on crit hits, `d0 / (ret43670 × mv_e0)` per
//!      attacker should be stable and equal 1 + critDmg%.
//!   5. motion-value constancy: `mv_e0` grouped by (attacker, action) —
//!      constant ⇒ the +0xE0 slot is the authored per-action motion value.
//!
//! Level-sync quests are excluded at capture time (checklist); this scorer
//! additionally refuses obviously-synced captures only via the round notes —
//! there is no quest id on these lines.
//!
//! Run: cargo run --release -p gbfr-logs --example dmg_head_check -- <capture.log>
//! Tests: cargo test -p gbfr-logs --example dmg_head_check   (DEBUG build —
//! the release test binary inherits the admin manifest and dies with os 740.)

use std::collections::BTreeMap;

/// Variance gate: BOTH flag masks must be set (builder decompile).
const VARIANCE_MASK_A: u64 = 0x1000001000000;
const VARIANCE_MASK_B: u64 = 0x100000000000;

#[derive(Debug, Clone, Default)]
struct HeadLine {
    inst: u64,
    action: u32,
    ret44920: f32,
    ret43670: f32,
    mv_e0: f32,
    crit_rate: f32,
    class_flags: u32,
    flags: u64,
    /// bytes 0x15D..=0x167; [0] = is-crit.
    gates: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
struct DiagLine {
    src_type: u32,
    src_idx: u32,
    d0: i64,
    d4: i64,
    action: u32,
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
        crit_rate: f32_field(line, "crit_rate=").unwrap_or(f32::NAN),
        class_flags: u64_hex_field(line, "class_flags=")? as u32,
        flags: u64_hex_field(line, "flags=")?,
        gates,
    })
}

fn parse_dmgdiag_line(line: &str) -> Option<DiagLine> {
    if !line.contains("DMGDIAG ") {
        return None;
    }
    Some(DiagLine {
        src_type: u64_hex_field(line, "src_type=")? as u32,
        src_idx: field(line, "src_idx=")?.parse().ok()?,
        d0: field(line, "unk@d0=")?.parse().ok()?,
        d4: field(line, "dmg@d4=")?.parse().ok()?,
        action: field(line, "action@16c=")?.parse().ok()?,
    })
}

#[derive(Debug, PartialEq)]
enum Verdict {
    /// Non-variance hit whose stored d4 equals trunc(ret44920).
    StoreExact,
    /// Variance-flagged hit inside the one-sided [1.0, 1.05) band.
    VarianceOk,
    /// Variance-flagged hit OUTSIDE the band — a missing branch, not noise.
    VarianceBad(f32),
    /// Non-variance hit whose stored d4 disagrees — model/capture defect.
    StoreMismatch { expect: i64, got: i64 },
}

fn score_store(head: &HeadLine, diag: &DiagLine) -> Verdict {
    let stored = diag.d4;
    let expect = head.ret44920.trunc() as i64;
    let variance =
        head.flags & VARIANCE_MASK_A == VARIANCE_MASK_A && head.flags & VARIANCE_MASK_B != 0;
    if !variance {
        if stored == expect {
            Verdict::StoreExact
        } else {
            Verdict::StoreMismatch {
                expect,
                got: stored,
            }
        }
    } else {
        let ratio = stored as f32 / expect.max(1) as f32;
        if (1.0..1.0500002).contains(&ratio) {
            Verdict::VarianceOk
        } else {
            Verdict::VarianceBad(ratio)
        }
    }
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

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: dmg_head_check <capture.log>");
        std::process::exit(2);
    });
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    });

    // Join each DMGHEAD to the nearest following DMGDIAG with the same action.
    let lines: Vec<&str> = text.lines().collect();
    let mut pairs: Vec<(HeadLine, DiagLine)> = Vec::new();
    let mut unjoined = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let Some(head) = parse_dmghead_line(line) else {
            continue;
        };
        let joined = lines[i + 1..]
            .iter()
            .take(40)
            .find_map(|l| parse_dmgdiag_line(l).filter(|d| d.action == head.action));
        match joined {
            Some(diag) => pairs.push((head, diag)),
            None => unjoined += 1,
        }
    }

    let mut store_exact = 0usize;
    let mut variance_ok = 0usize;
    let mut variance_bad: Vec<(u32, f32)> = Vec::new();
    let mut store_mismatch: Vec<(u32, i64, i64)> = Vec::new();
    let mut d0_exact = 0usize;
    let mut d0_mismatch: Vec<(u32, i64, i64)> = Vec::new();
    let mut crit_mults: BTreeMap<(u32, u32), Vec<f32>> = BTreeMap::new();
    let mut mv_by_action: BTreeMap<(u32, u32), Vec<f32>> = BTreeMap::new();

    for (head, diag) in &pairs {
        match score_store(head, diag) {
            Verdict::StoreExact => store_exact += 1,
            Verdict::VarianceOk => variance_ok += 1,
            Verdict::VarianceBad(r) => variance_bad.push((head.action, r)),
            Verdict::StoreMismatch { expect, got } => {
                store_mismatch.push((head.action, expect, got))
            }
        }
        match score_d0(head, diag) {
            Ok(None) => d0_exact += 1,
            Ok(Some(mult)) => crit_mults
                .entry((diag.src_type, diag.src_idx))
                .or_default()
                .push(mult),
            Err((expect, got)) => d0_mismatch.push((head.action, expect, got)),
        }
        mv_by_action
            .entry((diag.src_type, head.action))
            .or_default()
            .push(head.mv_e0);
    }

    println!("pairs={} unjoined_heads={}", pairs.len(), unjoined);
    println!(
        "store: exact={} variance_ok={} variance_bad={} mismatch={}",
        store_exact,
        variance_ok,
        variance_bad.len(),
        store_mismatch.len()
    );
    println!(
        "d0: exact_noncrit={} mismatch={}",
        d0_exact,
        d0_mismatch.len()
    );

    for (action, expect, got) in store_mismatch.iter().take(20) {
        let off = (*got - *expect) as f64 / (*expect).max(1) as f64 * 100.0;
        println!("  WORKLIST store action={action} expect={expect} got={got} ({off:+.2}%)");
    }
    for (action, ratio) in variance_bad.iter().take(20) {
        println!("  WORKLIST variance action={action} ratio={ratio:.4}");
    }
    for (action, expect, got) in d0_mismatch.iter().take(20) {
        let off = (*got - *expect) as f64 / (*expect).max(1) as f64 * 100.0;
        println!("  WORKLIST d0 action={action} expect={expect} got={got} ({off:+.2}%)");
    }

    println!("crit multiplier clusters (attacker -> n, min, max):");
    for ((src, idx), mults) in &crit_mults {
        let (min, max) = mults
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), m| (a.min(*m), b.max(*m)));
        println!(
            "  {src:#010x}/{idx}: n={} min={min:.4} max={max:.4}",
            mults.len()
        );
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
        "motion value: {} (attacker, action) groups, {} UNSTABLE (authored-constant hypothesis violated):",
        mv_by_action.len(),
        unstable.len()
    );
    for ((src, action), vs) in unstable.iter().take(20) {
        println!("  WORKLIST mv {src:#010x} action={action} values={vs:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "12:00:00 [INFO] DMGHEAD t=123 inst=0x7ff600 action=13010 \
        ret44920=15234.900391 ret43670=1201.700012 mv_e0=8.500000 d8=0.000000 rate_dc=1.000 \
        crit_rate=0.2500 class_flags=0x10000 flags=0x1000000 \
        gates=[00,01,00,00,00,00,00,00,00,00,01] elem_in=2";
    const DIAG: &str = "12:00:00 [INFO] DMGDIAG src_type=0x0026a725 src_idx=1 unk@d0=10214 \
        dmg@d4=15234 rate@d8=0 rate@dc=1 flags@e8=0x1000000 action@16c=13010 floor@2b8=-1 \
        cap@2bc=1211735 precap@2d4=15234 nonzero: [0xd0]=10214";

    #[test]
    fn parses_a_dmghead_line() {
        let p = parse_dmghead_line(HEAD).expect("parses");
        assert_eq!(p.inst, 0x7ff600);
        assert_eq!(p.action, 13010);
        assert_eq!(p.class_flags, 0x10000);
        assert_eq!(p.gates.len(), 11);
        assert_eq!(p.gates[1], 1);
        assert!(parse_dmghead_line("random noise").is_none());
    }

    #[test]
    fn parses_a_dmgdiag_line() {
        let d = parse_dmgdiag_line(DIAG).expect("parses");
        assert_eq!(d.src_type, 0x0026a725);
        assert_eq!(d.d4, 15234);
        assert_eq!(d.action, 13010);
    }

    #[test]
    fn non_variance_store_must_be_exact() {
        let head = HeadLine {
            ret44920: 15234.9,
            flags: 0, // variance masks clear
            ..Default::default()
        };
        let diag = DiagLine {
            d4: 15234,
            ..Default::default()
        };
        assert_eq!(score_store(&head, &diag), Verdict::StoreExact);
        let off = DiagLine {
            d4: 15235,
            ..Default::default()
        };
        assert!(matches!(
            score_store(&head, &off),
            Verdict::StoreMismatch { .. }
        ));
    }

    #[test]
    fn variance_band_is_one_sided() {
        let head = HeadLine {
            ret44920: 10000.0,
            flags: VARIANCE_MASK_A | VARIANCE_MASK_B,
            ..Default::default()
        };
        let ok = DiagLine {
            d4: 10400,
            ..Default::default()
        };
        assert_eq!(score_store(&head, &ok), Verdict::VarianceOk);
        // Below 1.0 is NOT variance — the roll only adds.
        let low = DiagLine {
            d4: 9990,
            ..Default::default()
        };
        assert!(matches!(score_store(&head, &low), Verdict::VarianceBad(_)));
    }

    #[test]
    fn d0_noncrit_is_exact_and_crit_yields_multiplier() {
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
        let crit_head = HeadLine {
            gates: {
                let mut g = vec![0; 11];
                g[0] = 1;
                g
            },
            ..head
        };
        let crit_diag = DiagLine {
            d0: 3750,
            ..Default::default()
        };
        assert_eq!(score_d0(&crit_head, &crit_diag), Ok(Some(1.5)));
    }
}
