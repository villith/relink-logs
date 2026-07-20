//! Read-only snapshot of the game's meditation RNG state via ReadProcessMemory.
//!
//! The meditation roll is a pure function of the baked tables plus a
//! per-(character, size) RNG slot, so the snapshot only needs the RNG slot
//! array and the character roster vector (for character -> slot index).
//! Globals are resolved by sigscanning the on-disk exe, cached per exe path
//! (see `game_mem`).

use crate::game_mem::{self, RNG_SLOT_COUNT};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Anchored on the PL0100/PL0000 id compares inside the meditation roll
/// (FUN_141beb1b0); cursor lands on the disp32 of `mov rax, [rip+disp]`
/// loading the character roster global.
const ROSTER_SIG: &str = "81 f9 76 ba ac a4 74 ? 81 f9 b2 b1 26 2a 75 ? 8d 0c 9b 44 8d 04 cb 42 8d 14 00 83 c2 05 48 8b 0d ? ? ? ? 83 fa ff 74 ? 44 01 c0 83 f8 7d 7f ? eb ? 48 8b 05 ' ? ? ? ?";

const MAX_ROSTER: u64 = 64;

#[derive(Debug)]
pub struct OvermasterySnapshot {
    /// xorshift32 state per RNG slot at snapshot time.
    pub slots: Vec<u32>,
    /// Slot override word (0xffffffff when idle; anything else means a roll
    /// is mid-flight and predictions would race it).
    pub slot_override: u32,
    /// Character id hashes (game custom-XXHash32 of "PL####"), in roster
    /// order; a character's slot index is its position here (protagonists
    /// PL0000/PL0100 are index 0).
    pub roster: Vec<u32>,
}

/// Sigscan the on-disk exe for the RNG and roster globals.
fn resolve_globals(exe: &Path) -> Result<(u32, u32)> {
    static CACHE: Mutex<Option<(PathBuf, [u32; 2])>> = Mutex::new(None);
    let [rng, roster] = game_mem::resolve_globals_cached(&CACHE, exe, |pe| {
        Ok([
            game_mem::resolve_rng_rva(pe)?,
            game_mem::scan_unique_rva(pe, ROSTER_SIG, "roster")?,
        ])
    })?;
    Ok((rng, roster))
}

/// Light read of one RNG slot's state (`slot` < `RNG_SLOT_COUNT`) for
/// staleness polling — a single 4-byte read, no roster walk. `Ok(None)` =
/// game not running.
pub fn take_slot_state(slot: u32) -> Result<Option<u32>> {
    if slot as usize >= RNG_SLOT_COUNT {
        bail!("slot {slot:#x} out of range");
    }
    let Some((mem, base, exe)) = game_mem::open_game()? else {
        return Ok(None);
    };
    let (rng_rva, _) = resolve_globals(&exe)?;
    let rng = mem.u64(base + rng_rva as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }
    Ok(Some(mem.u32(rng + slot as u64 * 4)?))
}

/// Take a meditation RNG snapshot. `Ok(None)` = game not running.
pub fn take_snapshot() -> Result<Option<OvermasterySnapshot>> {
    let Some((mem, base, exe)) = game_mem::open_game()? else {
        return Ok(None);
    };
    let (rng_rva, roster_rva) = resolve_globals(&exe)?;

    let rng = mem.u64(base + rng_rva as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }

    let mut block = vec![0u8; RNG_SLOT_COUNT * 4 + 4];
    mem.read(rng, &mut block)?;
    let word = |i: usize| u32::from_le_bytes(block[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    let slots: Vec<u32> = (0..RNG_SLOT_COUNT).map(word).collect();
    // RNG_SLOT_OVERRIDE == RNG_SLOT_COUNT * 4 is asserted at compile time in
    // game_mem, so the override word is simply the slot after the last one.
    let slot_override = word(RNG_SLOT_COUNT);

    // The global holds a pointer to the roster object; the id vector's
    // begin/end pointers sit at +8 / +0x10 of THAT object.
    let roster_obj = mem.u64(base + roster_rva as u64)?;
    if roster_obj == 0 {
        bail!("roster object not initialized yet (still on title screen?)");
    }
    let begin = mem.u64(roster_obj + 8)?;
    let end = mem.u64(roster_obj + 0x10)?;
    if begin == 0 || end < begin || (end - begin) % 4 != 0 {
        bail!("roster vector looks torn ({begin:#x}..{end:#x})");
    }
    let count = (end - begin) / 4;
    if count > MAX_ROSTER {
        bail!("roster claims {count} characters");
    }
    let mut buf = vec![0u8; count as usize * 4];
    if !buf.is_empty() {
        mem.read(begin, &mut buf)?;
    }
    let roster = buf
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().expect("4 bytes")))
        .collect();

    Ok(Some(OvermasterySnapshot { slots, slot_override, roster }))
}
