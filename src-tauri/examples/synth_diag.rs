//! Live diagnostic for the synthesis snapshot + engine.
//!
//! Usage (game running, as admin):
//!   cargo run -p gbfr-logs --example synth_diag            # snapshot summary
//!   cargo run -p gbfr-logs --example synth_diag <uidA> <uidB>   # predict one pair (hex uids)

use gbfr_logs::synthesis::{self, snapshot};

fn main() -> anyhow::Result<()> {
    let snap = match snapshot::take_snapshot()? {
        Some(s) => s,
        None => {
            println!("game not running");
            return Ok(());
        }
    };
    println!(
        "rng_state={:#010x} seed_counter={} sigils={} pair_counters={} weights={} trait_to_item={}",
        snap.rng_state,
        snap.seed_counter,
        snap.sigils.len(),
        snap.pair_counters.len(),
        snap.level_weights.len(),
        snap.trait_to_item.len(),
    );
    let mut weights: Vec<_> = snap.level_weights.iter().collect();
    weights.sort();
    println!("weights: {weights:?}");
    for s in snap.sigils.iter().take(10) {
        println!(
            "  uid={:#010x} sigil={:#010x} t1={:#010x} l{} t2={:#010x} l{} rec={}",
            s.uid, s.sigil_id, s.trait1, s.trait1_level, s.trait2, s.trait2_level, s.record_level
        );
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [a, b] = args.as_slice() {
        let parse = |s: &str| u32::from_str_radix(s.trim_start_matches("0x"), 16).unwrap();
        let (ua, ub) = (parse(a), parse(b));
        let find = |uid: u32| {
            snap.sigils
                .iter()
                .find(|s| s.uid == uid)
                .expect("uid not found")
        };
        let p = synthesis::predict(&snap, find(ua), find(ub));
        println!(
            "prediction: trait1={:#010x} trait2={:x?} lucky={}",
            p.trait1, p.trait2, p.lucky
        );
    }
    Ok(())
}
