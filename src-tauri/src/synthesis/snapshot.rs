//! Read-only snapshot of the game's synthesis state via ReadProcessMemory.
//!
//! Global RVAs are resolved by sigscanning the exe on disk (pelite), cached
//! per exe path (see `game_mem`). All reads are bounds-checked; a torn/absurd
//! read fails the snapshot rather than producing wrong predictions.

use super::{SynthesisSigil, SynthesisSnapshot};
use crate::game_mem::{self, Mem, RNG_SLOT_OVERRIDE};
use anyhow::{bail, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// Cursor lands on the disp32 of `mov rdi/rcx, [rip+disp]`; global RVA = cursor + 4 + disp.
const COMMIT_SIG: &str = "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec ? ? 00 00 48 8d ac 24 80 00 00 00 48 c7 85 ? ? 00 00 fe ff ff ff 48 8b 3d ' ? ? ? ? 48 8b 05";

// Sigil-manager struct offsets (v2.0.2 layout; see the plan's offset table).
const MGR_ITEM_MAP: u64 = 0x0;
const MGR_WEIGHT_MAP: u64 = 0x180;
const MGR_TRAIT_ITEM_MAP: u64 = 0x240;
const MGR_SEED_COUNTER: u64 = 0x2d8;
const MGR_PAIR_MAP: u64 = 0x2e0;
const MGR_UID_MAP: u64 = 0x37f80;
const RNG_SYNTH_STATE: u64 = 0x81 * 4; // slot 0x81

const MAX_MAP_ENTRIES: u64 = 500_000;

/// Sigscan the on-disk exe for the two globals (manager + RNG array).
fn resolve_globals(exe: &Path) -> Result<(u32, u32)> {
    static CACHE: Mutex<Option<(PathBuf, [u32; 2])>> = Mutex::new(None);
    let [mgr, rng] = game_mem::resolve_globals_cached(&CACHE, exe, |pe| {
        Ok([
            game_mem::scan_unique_rva(pe, COMMIT_SIG, "commit")?,
            game_mem::resolve_rng_rva(pe)?,
        ])
    })?;
    Ok((mgr, rng))
}

/// Walk an MSVC std::unordered_map's node list. `header` is the address of
/// the map header ({load_factor, sentinel*, size, ...}); calls `f(node_addr)`
/// for each node ({link, link, key @0x10, value @0x14/0x18}).
fn walk_map(mem: &Mem, header: u64, mut f: impl FnMut(u64) -> Result<()>) -> Result<()> {
    let sentinel = mem.u64(header + 8)?;
    if sentinel == 0 {
        bail!("map at {header:#x} has null sentinel");
    }
    let size = mem.u64(header + 0x10)?;
    if size > MAX_MAP_ENTRIES {
        bail!("map at {header:#x} claims {size} entries");
    }
    let mut node = mem.u64(sentinel)?;
    let mut visited = 0u64;
    while node != sentinel {
        f(node)?;
        visited += 1;
        if visited > size {
            bail!("map walk at {header:#x} overran its size ({size})");
        }
        node = mem.u64(node)?;
    }
    Ok(())
}

/// Light read of just the synthesis seed identity (RNG slot 0x81 state +
/// manager seed counter) for staleness polling — no map walks. `Ok(None)` =
/// game not running.
pub fn take_seed_state() -> Result<Option<super::SynthesisSeed>> {
    let Some((mem, base, exe)) = game_mem::open_game()? else {
        return Ok(None);
    };
    let (mgr_rva, rng_rva) = resolve_globals(&exe)?;
    let mgr = mem.u64(base + mgr_rva as u64)?;
    let rng = mem.u64(base + rng_rva as u64)?;
    if mgr == 0 || rng == 0 {
        bail!("synthesis globals not initialized yet (still on title screen?)");
    }
    Ok(Some(super::SynthesisSeed {
        rng_state: mem.u32(rng + RNG_SYNTH_STATE)?,
        seed_counter: mem.u32(mgr + MGR_SEED_COUNTER)?,
    }))
}

/// Take a full synthesis snapshot. `Ok(None)` = game not running.
pub fn take_snapshot() -> Result<Option<SynthesisSnapshot>> {
    let Some((mem, base, exe)) = game_mem::open_game()? else {
        return Ok(None);
    };
    let (mgr_rva, rng_rva) = resolve_globals(&exe)?;

    let mgr = mem.u64(base + mgr_rva as u64)?;
    let rng = mem.u64(base + rng_rva as u64)?;
    if mgr == 0 || rng == 0 {
        bail!("synthesis globals not initialized yet (still on title screen?)");
    }

    let mut snap = SynthesisSnapshot {
        rng_state: mem.u32(rng + RNG_SYNTH_STATE)?,
        seed_counter: mem.u32(mgr + MGR_SEED_COUNTER)?,
        ..Default::default()
    };
    let slot_override = mem.u32(rng + RNG_SLOT_OVERRIDE)?;
    if slot_override != u32::MAX {
        // All draws would come from another slot; predictions would be wrong.
        bail!("rng slot override active ({slot_override:#x}) — unsupported");
    }

    // item id -> record level (feeds the warm-up pairKey)
    let mut record_levels: HashMap<u32, i32> = HashMap::new();
    walk_map(&mem, mgr + MGR_ITEM_MAP, |node| {
        let item_id = mem.u32(node + 0x10)?;
        let record = mem.u64(node + 0x18)?;
        if record != 0 {
            record_levels.insert(item_id, mem.i32(record + 8)?);
        }
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_WEIGHT_MAP, |node| {
        let key = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val != 0 {
            snap.level_weights
                .insert(key, (mem.u32(val)?, mem.u32(val + 4)?));
        }
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_TRAIT_ITEM_MAP, |node| {
        let trait_id = mem.u32(node + 0x10)?;
        snap.trait_to_item.insert(trait_id, mem.u32(node + 0x14)?);
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_PAIR_MAP, |node| {
        let key = mem.u64(node + 0x10)?;
        snap.pair_counters.insert(key, mem.u32(node + 0x18)?);
        Ok(())
    })?;

    walk_map(&mem, mgr + MGR_UID_MAP, |node| {
        let uid = mem.u32(node + 0x10)?;
        let val = mem.u64(node + 0x18)?;
        if val == 0 {
            return Ok(());
        }
        let mut b = [0u8; 20];
        mem.read(val, &mut b)?;
        let field = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().expect("4-byte field"));
        let sigil_id = field(16);
        snap.sigils.push(SynthesisSigil {
            uid,
            sigil_id,
            trait1: field(0),
            trait1_level: field(4),
            trait2: field(8),
            trait2_level: field(12),
            record_level: record_levels.get(&sigil_id).copied().unwrap_or(0),
        });
        Ok(())
    })?;

    Ok(Some(snap))
}
