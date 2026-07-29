//! Ground-truth probe for the Transmarvel roll predictor
//! (investigation tool, not shipped).
//!
//! Phase 1a: identify which RNG slot(s) a transmarvel roll consumes.
//!
//! Usage (game running, as admin):
//!   cargo run -p gbfr-logs --example transmarvel_probe -- dump
//!   cargo run -p gbfr-logs --example transmarvel_probe -- save <file>
//!   cargo run -p gbfr-logs --example transmarvel_probe -- diff <file>
//!   cargo run -p gbfr-logs --example transmarvel_probe -- predict [n]
//!
//! Slot-identification protocol (record results in the phase-1 notes file):
//!   0. At Siero's transmarvel screen, `save idle.txt`, wait ~30s WITHOUT
//!      rolling, `diff idle.txt` — the ambient baseline (the LCG pseudo-slot
//!      ticks ~40-60 draws/sec even idle; per-roll LCG consumption is only
//!      readable relative to this).
//!   1. `save pre.txt`.
//!   2. Do ONE transmarvel roll (points). Note the outcome exactly
//!      (sigil + trait, or wrightstone + traits + levels).
//!   3. `diff pre.txt` -> expect one slot advanced by a small draw count.
//!   4. Repeat for: a voucher roll, a roll that yields a sigil, a roll that
//!      yields a wrightstone. Record slot + draws each time.

use game_reader::{rva_from_cursor, scan_cursors, MemRead, RNG_SLOT_COUNT, RNG_SLOT_OVERRIDE};
use gbfr_logs::game_mem;
use pelite::pe64::PeFile;

/// The idle-ticking LCG global (see reward_probe.rs): watched as a pseudo-slot
/// appended after the 0x83 xorshift32 slots + override word, in case the
/// transmarvel roll draws from it instead of the slot array.
const LCG_SIG: &str = "8b 0d ' ? ? ? ? 69 d1 0d 66 19 00";

fn lcg_step(s: u32) -> u32 {
    s.wrapping_mul(0x19660d).wrapping_add(0x3c6ef35f)
}

/// Index of the slot-override word in the saved state vector.
const IDX_OVERRIDE: usize = RNG_SLOT_COUNT;
/// Index of the LCG pseudo-slot in the saved state vector.
const IDX_LCG: usize = RNG_SLOT_COUNT + 1;

/// All 0x83 xorshift32 slot states, the slot-override word, then the LCG
/// state as a final pseudo-slot.
fn states() -> anyhow::Result<Vec<u32>> {
    let (mem, base, exe) =
        game_mem::open_game()?.ok_or_else(|| anyhow::anyhow!("game not running (run as admin)"))?;
    let data = std::fs::read(&exe)?;
    let pe = PeFile::from_bytes(&data)?;
    let rng_rva = game_reader::resolve_rng_rva(pe)?;
    // LCG sig matches many inlined sites that must all decode to one global.
    let mut lcg_rvas: Vec<u32> = scan_cursors(pe, LCG_SIG)?
        .into_iter()
        .map(|c| rva_from_cursor(pe, c))
        .collect::<anyhow::Result<_>>()?;
    lcg_rvas.sort_unstable();
    lcg_rvas.dedup();
    anyhow::ensure!(lcg_rvas.len() == 1, "LCG sites decode to {lcg_rvas:x?}");

    let rng_ptr = mem.u64(base + rng_rva as u64)?;
    anyhow::ensure!(rng_ptr != 0, "rng array not initialized (title screen?)");
    let mut buf = vec![0u8; RNG_SLOT_COUNT * 4];
    mem.read(rng_ptr, &mut buf)?;
    let mut states: Vec<u32> = buf
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    states.push(mem.u32(rng_ptr + RNG_SLOT_OVERRIDE)?);
    states.push(mem.u32(base + lcg_rvas[0] as u64)?);
    Ok(states)
}

fn label(i: usize) -> String {
    match i {
        IDX_OVERRIDE => "override ".into(),
        IDX_LCG => "lcg      ".into(),
        _ => format!("slot {i:#04x}"),
    }
}

/// Item hash -> English name, from the lang files (best effort — raw hash on
/// any miss). Sigils and wrightstones live in different files.
fn item_names() -> std::collections::HashMap<u32, String> {
    let mut out = std::collections::HashMap::new();
    for file in ["sigils.json", "items.json", "traits.json"] {
        let path = format!("{}/lang/en/{file}", env!("CARGO_MANIFEST_DIR"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, serde_json::Value>>(&text)
        else {
            continue;
        };
        for (hash, entry) in map {
            if let (Ok(hash), Some(name)) = (
                u32::from_str_radix(&hash, 16),
                entry.get("text").and_then(|t| t.as_str()),
            ) {
                out.insert(hash, name.to_string());
            }
        }
    }
    out
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("dump") => {
            for (i, s) in states()?.iter().enumerate() {
                println!("{}: {s:08x}", label(i));
            }
        }
        Some("save") => {
            let path = args.get(1).ok_or_else(|| anyhow::anyhow!("save <file>"))?;
            let text: String = states()?.iter().map(|s| format!("{s:08x}\n")).collect();
            std::fs::write(path, text)?;
            println!("saved {path}");
        }
        Some("diff") => {
            let path = args.get(1).ok_or_else(|| anyhow::anyhow!("diff <file>"))?;
            let old: Vec<u32> = std::fs::read_to_string(path)?
                .lines()
                .map(|l| u32::from_str_radix(l.trim(), 16))
                .collect::<Result<_, _>>()?;
            let new = states()?;
            anyhow::ensure!(old.len() == new.len(), "slot count mismatch");
            let mut changed = 0;
            for (i, (o, n)) in old.iter().zip(&new).enumerate() {
                if o == n {
                    continue;
                }
                changed += 1;
                if i == IDX_OVERRIDE {
                    println!("override : {o:08x} -> {n:08x}");
                    continue;
                }
                // How many draws take o -> n?
                let step: fn(u32) -> u32 = if i == IDX_LCG {
                    lcg_step
                } else {
                    game_reader::xorshift32
                };
                let mut s = *o;
                let mut draws = 0u32;
                for d in 1..=1_000_000u32 {
                    s = step(s);
                    if s == *n {
                        draws = d;
                        break;
                    }
                }
                if draws > 0 {
                    println!("{}: {o:08x} -> {n:08x} (+{draws} draws)", label(i));
                } else {
                    println!(
                        "{}: {o:08x} -> {n:08x} (NOT an advance — reseeded?)",
                        label(i)
                    );
                }
            }
            println!("({changed} entries changed; unchanged omitted)");
        }
        Some("predict") => {
            let n: u32 = args.get(1).map(|s| s.parse()).transpose()?.unwrap_or(5);
            let snap = game_mem::rpm_rng_slot(gbfr_logs::transmarvel::TM_SLOT)?
                .ok_or_else(|| anyhow::anyhow!("game not running (run as admin)"))?;
            if snap.slot_override != u32::MAX {
                println!(
                    "slot_override {:#x} — roll mid-flight, retry",
                    snap.slot_override
                );
                return Ok(());
            }
            if snap.state == 0 {
                println!("state 0 — game will reseed from entropy; unpredictable");
                return Ok(());
            }
            let names = item_names();
            let name = |hash: u32| {
                names
                    .get(&hash)
                    .cloned()
                    .unwrap_or_else(|| format!("{hash:08x}"))
            };
            println!("slot 0x04 state {:08x}", snap.state);
            let t = gbfr_logs::transmarvel::stock_tables();
            for (i, roll) in gbfr_logs::transmarvel::simulate(snap.state, t, n)
                .iter()
                .enumerate()
            {
                use gbfr_logs::transmarvel::TransmarvelOutcome::*;
                let what = match &roll.outcome {
                    Sigil {
                        sigil_id,
                        trait_level,
                        trait2,
                        ..
                    } => {
                        let lvl = match trait_level {
                            0 => String::new(),
                            lvl => format!(" (lvl {lvl})"),
                        };
                        let second = match trait2 {
                            Some(t) => format!(" + 2nd trait {}", name(*t)),
                            None => String::new(),
                        };
                        format!("GEM   {}{lvl}{second}", name(*sigil_id))
                    }
                    Wrightstone { item, traits } => {
                        let traits = traits
                            .iter()
                            .map(|&(t, lvl)| format!("{} {lvl}", name(t)))
                            .collect::<Vec<_>>()
                            .join(" / ");
                        format!("STONE {}: {traits}", name(*item))
                    }
                };
                println!("roll #{}: {what} (+{} draws)", i + 1, roll.draws);
            }
        }
        _ => eprintln!("usage: transmarvel_probe dump | save <file> | diff <file> | predict [n]"),
    }
    Ok(())
}
