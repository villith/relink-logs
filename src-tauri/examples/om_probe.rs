//! Ground-truth probe for the Overmastery (meditation) roll predictor
//! (investigation tool, not shipped).
//!
//! Dumps the meditation RNG slot states + character roster, and prints the
//! predicted next rolls for a character/size so they can be compared against
//! an ACTUAL in-game meditation.
//!
//! Usage (game running, as admin):
//!   cargo run -p gbfr-logs --example om_probe                    # roster + live slot states
//!   cargo run -p gbfr-logs --example om_probe <charHex> <tier> [rolls]
//!       e.g. om_probe 2a26b1b2 1 3   -> predict next 3 medium rolls for Gran
//!
//! Validation protocol (record results in scratchpad notes):
//!   1. Run with a char+tier BEFORE meditating; note the predicted roll #1.
//!   2. Do that exact meditation in-game; record the 4 masteries + values.
//!   3. Re-run the probe: the slot state should now equal the predicted
//!      post-roll state (8 draws consumed on a guarantee-fired medium roll,
//!      10 otherwise), and prediction #2 should have shifted to #1.
//!   4. Also verify: a DIFFERENT character/size leaves this slot untouched;
//!      protagonist (Gran/Djeeta) uses char index 0; roster order matches
//!      char_slot_index expectations.

use gbfr_logs::game_mem;
use gbfr_logs::overmastery::{char_slot_index, rng_slot, simulate, stock_tables};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let snap =
        game_mem::rpm_overmastery_snapshot()?.ok_or_else(|| anyhow::anyhow!("game not running"))?;

    println!("slot_override: {:#x}", snap.slot_override);
    println!("roster ({} chars):", snap.roster.len());
    for (i, id) in snap.roster.iter().enumerate() {
        println!("  idx {i:2}: {id:08x}");
    }

    if args.is_empty() {
        println!("\nmeditation slot states (slot = 5 + tier*0x29 + charIdx):");
        for tier in 0..3 {
            let base = rng_slot(tier, 0) as usize;
            let states: Vec<String> = (0..snap.roster.len().clamp(1, 0x29))
                .map(|i| format!("{:08x}", snap.slots[base + i]))
                .collect();
            println!("  tier {tier}: {}", states.join(" "));
        }
        return Ok(());
    }

    let char_id = u32::from_str_radix(&args[0], 16)?;
    let tier: usize = args.get(1).map(|s| s.parse()).transpose()?.unwrap_or(1);
    let rolls: u32 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(3);

    let idx = char_slot_index(&snap.roster, char_id)
        .ok_or_else(|| anyhow::anyhow!("char {char_id:08x} not in roster"))?;
    let slot = rng_slot(tier as u32, idx);
    let state = snap.slots[slot as usize];
    println!("\nchar {char_id:08x} idx {idx} tier {tier} -> slot {slot:#x} state {state:08x}");
    if state == 0 {
        println!("state is 0 -> game will reseed from entropy; unpredictable");
        return Ok(());
    }

    let t = stock_tables();
    for (n, roll) in simulate(state, tier, t, rolls).iter().enumerate() {
        println!("roll #{}:", n + 1);
        for m in roll {
            println!(
                "  cat {:08x} kind {:3} level {:2} value {}",
                m.category, m.kind, m.level, m.value
            );
        }
    }
    println!("\n(post-roll slot state advances 10 draws, or 8 when the medium guarantee fires)");
    Ok(())
}
