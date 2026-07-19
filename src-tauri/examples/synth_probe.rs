//! Ground-truth RNG probe for Sigil Synthesis (investigation tool, not shipped).
//!
//! The shipped predict() model is known-wrong (title-reset repeatability + the
//! one-trait-from-each rule). This probe dumps every input the game's synthesis
//! algorithm uses for a chosen pair so we can correlate them with the ACTUAL
//! in-game result and reverse the true model — instead of guessing from the
//! decompile.
//!
//! Usage (game running, as admin, sitting in the Sigil Synthesis menu is NOT
//! required — this reads persistent manager state):
//!   cargo run -p gbfr-logs --example synth_probe                  # list eligible sigils
//!   cargo run -p gbfr-logs --example synth_probe <uidA> <uidB>    # full trace for a pair (hex)
//!
//! Protocol for reversing the RNG (record results in the scratchpad notes):
//!   1. From title, load your save. Run `synth_probe` to list sigils.
//!   2. Pick a pair; run `synth_probe <uidA> <uidB>` and record the trace
//!      (pairKey, count, seed_counter, rng_state, the 4 cross combos).
//!   3. Synthesize that exact pair in-game (mod OFF). Record the actual result
//!      traits (in slot order) + whether it was the high-level (15) roll.
//!   4. Repeat step 2-3 for the SAME pair several times (count increments) and
//!      for a DIFFERENT pair, then title-reset and repeat to confirm the
//!      sequence is a pure function of (seed, pairKey, count).

use gbfr_logs::synthesis::{self, snapshot, SynthesisQuery, SynthesisSigil, EMPTY_TRAIT};

fn eligible(s: &SynthesisSigil) -> bool {
    // Working hypothesis for rule #1/#2: two real traits, both >= level 11.
    s.trait1 != EMPTY_TRAIT
        && s.trait2 != EMPTY_TRAIT
        && s.trait1_level >= 11
        && s.trait2_level >= 11
}

fn traits(s: &SynthesisSigil) -> Vec<u32> {
    [s.trait1, s.trait2]
        .into_iter()
        .filter(|&t| t != EMPTY_TRAIT)
        .collect()
}

fn main() -> anyhow::Result<()> {
    let snap = match snapshot::take_snapshot()? {
        Some(s) => s,
        None => {
            println!("game not running");
            return Ok(());
        }
    };

    let args: Vec<String> = std::env::args().skip(1).collect();

    // `synth_probe search <hexTrait1> [hexTrait2] [any] [lucky]` runs the real
    // fixed search() and prints the corrected count + a few matches.
    if args.first().map(String::as_str) == Some("search") {
        let parse = |s: &str| u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap();
        let rest: Vec<&String> = args.iter().skip(1).collect();
        let trait1 = parse(rest[0]);
        let trait2 = rest
            .get(1)
            .filter(|s| s.as_str() != "any" && s.as_str() != "lucky")
            .map(|s| parse(s));
        let any_order = args.iter().any(|a| a == "any");
        let require_lucky = args.iter().any(|a| a == "lucky");
        let q = SynthesisQuery { trait1, trait2, any_order, require_lucky };
        let (matches, tested) = synthesis::search(&snap, &q);
        println!(
            "query trait1={trait1:#010x} trait2={trait2:x?} any_order={any_order} lucky={require_lucky}"
        );
        println!("pairs_tested={tested}  total_matches={}  (showing 20)", matches.len());
        for m in matches.iter().take(20) {
            println!(
                "  {:#010x}({:#010x}/{:#010x}) + {:#010x}({:#010x}/{:#010x}) -> {:#010x} {:x?} lucky={}",
                m.sigil_a.uid, m.sigil_a.trait1, m.sigil_a.trait2,
                m.sigil_b.uid, m.sigil_b.trait1, m.sigil_b.trait2,
                m.prediction.trait1, m.prediction.trait2, m.prediction.lucky
            );
        }
        return Ok(());
    }

    let is_list = args.is_empty() || args[0] == "list";
    if is_list {
        let elig: Vec<&SynthesisSigil> = snap.sigils.iter().filter(|s| eligible(s)).collect();
        println!(
            "rng_state={:#010x} seed_counter={} sigils={} eligible(2-trait,lvl>=11)={} pair_counters={}",
            snap.rng_state,
            snap.seed_counter,
            snap.sigils.len(),
            elig.len(),
            snap.pair_counters.len(),
        );
        // Optional trait-hash filters: `synth_probe list <hexTrait> [hexTrait2]`
        // prints only eligible sigils containing those trait(s).
        let filters: Vec<u32> = args
            .iter()
            .skip(1)
            .map(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap())
            .collect();
        println!("-- eligible sigils (uid  sigil  t1/l  t2/l  rec) --");
        let mut shown = 0;
        for s in &elig {
            if !filters.is_empty()
                && !filters.iter().all(|&f| s.trait1 == f || s.trait2 == f)
            {
                continue;
            }
            println!(
                "  {:#010x}  {:#010x}  {:#010x}/{:<2} {:#010x}/{:<2} rec={}",
                s.uid, s.sigil_id, s.trait1, s.trait1_level, s.trait2, s.trait2_level, s.record_level
            );
            shown += 1;
            if filters.is_empty() && shown >= 60 {
                println!("  ... (filter with: synth_probe list <hexTraitA> <hexTraitB>)");
                break;
            }
        }
        return Ok(());
    }

    if let [a, b] = args.as_slice() {
        let parse = |s: &str| u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap();
        let (ua, ub) = (parse(a), parse(b));
        let find = |uid: u32| {
            snap.sigils
                .iter()
                .find(|s| s.uid == uid)
                .unwrap_or_else(|| panic!("uid {uid:#x} not found"))
        };
        let (sa, sb) = (find(ua), find(ub));

        // Recompute the decompile's warm-up terms so we can correlate them with
        // the observed result. pairKey (per the commit trace) = traitsum(A) +
        // traitsum(B) + (rec_A + rec_B); the per-pair map is keyed on it.
        let tsum = |s: &SynthesisSigil| -> u64 {
            traits(s).iter().map(|&t| t as u64).sum()
        };
        let pair_key =
            tsum(sa) + tsum(sb) + (sa.record_level.wrapping_add(sb.record_level) as u32) as u64;
        let count = snap.pair_counters.get(&pair_key).copied().unwrap_or(0);

        println!("A uid={:#010x} traits={:x?} levels=[{},{}] rec={}", sa.uid, traits(sa), sa.trait1_level, sa.trait2_level, sa.record_level);
        println!("B uid={:#010x} traits={:x?} levels=[{},{}] rec={}", sb.uid, traits(sb), sb.trait1_level, sb.trait2_level, sb.record_level);
        println!("pair_key={pair_key}  count(this pair so far)={count}  seed_counter={}  rng_state={:#010x}", snap.seed_counter, snap.rng_state);
        println!("uidA={ua:#010x} uidB={ub:#010x}  (instance-dependence check: does swapping which copy changes result?)");

        // The FOUR possible results under rule #3 (one trait from each sigil):
        let (ta, tb) = (traits(sa), traits(sb));
        println!("-- rule#3 cross-product candidates (one from each) --");
        for &x in &ta {
            for &y in &tb {
                println!("   {x:#010x} + {y:#010x}");
            }
        }

        // Current (WRONG) shipped prediction, for reference/contrast.
        let p = synthesis::predict(&snap, sa, sb);
        println!(
            "[shipped predict() — KNOWN WRONG MODEL] trait1={:#010x} trait2={:x?} lucky={}",
            p.trait1, p.trait2, p.lucky
        );
        println!("\nNow synthesize A+B in-game (mod OFF) and record: result slot1, slot2, and level (11/15).");
    } else {
        println!("usage: synth_probe [<uidA> <uidB>]");
    }
    Ok(())
}
