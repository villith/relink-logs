//! Platform-independent readers for the game structures behind the Toolbox
//! tools (synthesis, overmastery): the RE'd signatures, struct offsets, and
//! snapshot walkers, generic over [`MemRead`].
//!
//! Two implementations exist: the hook reads in-process (guarded raw copies;
//! the production path on both platforms, served over the toolbox RPC
//! channel), and the diag probes in src-tauri/examples read out-of-process
//! via ReadProcessMemory as an independent ground-truth cross-check.
//! A game patch that moves these structures is fixed HERE, in one place.

use anyhow::{bail, Context, Result};
use pelite::pattern;
use pelite::pe64::Pe;
pub use protocol::toolbox::RngSlotState;

pub mod overmastery;
pub mod synthesis;
pub mod transmarvel;

/// The game process/module name (shared by the injector and the probes).
pub const GAME_EXE: &str = "granblue_fantasy_relink.exe";

/// The game's "empty" sentinel hash (no trait in this slot / missing key).
pub const EMPTY_KEY: u32 = 0x887a_e0b0;

/// The RNG slot-array global. Cursor lands on the disp32 of a rip-relative
/// load of the array pointer.
pub const RNG_SIG: &str = "48 8b 0d ' ? ? ? ? ba 81 00 00 00 e8";
/// Number of RNG slots (0..=0x82).
pub const RNG_SLOT_COUNT: usize = 0x83;
/// Offset of the slot-override word, right after the slots (0xffffffff when
/// idle; anything else redirects every draw to that slot).
pub const RNG_SLOT_OVERRIDE: u64 = 0x20c;
const _: () = assert!(RNG_SLOT_OVERRIDE == RNG_SLOT_COUNT as u64 * 4);

/// Dereference the RNG slot-array global to the array itself. The global is
/// null until the game leaves the title screen, so every RNG-backed tool has
/// to report that the same way.
pub fn deref_rng(mem: &impl MemRead, base: u64, rng_rva: u32) -> Result<u64> {
    let rng = mem.u64(base + rng_rva as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }
    Ok(rng)
}

/// Read one RNG slot's state plus the slot-override word — the single live
/// read every RNG-backed Toolbox tool needs. Transmarvel predicts from its
/// slot's state and uses the override to know no roll is mid-flight; the
/// staleness polls re-read their own slot and ignore the override.
pub fn read_rng_slot(
    mem: &impl MemRead,
    base: u64,
    rng_rva: u32,
    slot: u32,
) -> Result<RngSlotState> {
    if slot as usize >= RNG_SLOT_COUNT {
        bail!("slot {slot:#x} out of range");
    }
    let rng = deref_rng(mem, base, rng_rva)?;
    Ok(RngSlotState {
        state: mem.u32(rng + slot as u64 * 4)?,
        slot_override: mem.u32(rng + RNG_SLOT_OVERRIDE)?,
    })
}

/// One step of the game's per-slot RNG. Returns the new state, which is also
/// the drawn value.
#[inline]
pub fn xorshift32(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 15;
    s
}

/// A bounds-checked window into the game's memory. Implementors must fail
/// (not fault) on unreadable addresses — the walkers chase pointers out of
/// possibly-torn game structures.
pub trait MemRead {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()>;

    fn u64(&self, addr: u64) -> Result<u64> {
        let mut b = [0u8; 8];
        self.read(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    fn u32(&self, addr: u64) -> Result<u32> {
        let mut b = [0u8; 4];
        self.read(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn i32(&self, addr: u64) -> Result<i32> {
        Ok(self.u32(addr)? as i32)
    }
}

/// Decode the rip-relative disp32 a signature cursor points at:
/// global RVA = cursor + 4 + disp. (Callers can reuse the handle across
/// calls — `Pe` is `Copy`, and PeFile and PeView both implement it.)
pub fn rva_from_cursor<'a>(pe: impl Pe<'a>, cursor: u32) -> Result<u32> {
    let bytes: [u8; 4] = pe
        .derva_slice::<u8>(cursor, 4)
        .map_err(|e| anyhow::anyhow!("derva {cursor:#x}: {e:?}"))?
        .try_into()
        .expect("slice length is 4");
    Ok(cursor
        .wrapping_add(4)
        .wrapping_add(u32::from_le_bytes(bytes)))
}

/// All cursor RVAs matching `sig` (the pattern's save slot 1).
pub fn scan_cursors<'a>(pe: impl Pe<'a>, sig: &str) -> Result<Vec<u32>> {
    let pat = pattern::parse(sig).context("parse pattern")?;
    let mut out = Vec::new();
    let mut matches = pe.scanner().matches_code(&pat);
    let mut save = [0u32; 8];
    while matches.next(&mut save) {
        out.push(save[1]);
    }
    Ok(out)
}

/// Scan for `sig`, demanding exactly one match; returns the decoded global RVA.
pub fn scan_unique_rva<'a>(pe: impl Pe<'a>, sig: &str, what: &str) -> Result<u32> {
    let cursors = scan_cursors(pe, sig)?;
    if cursors.len() != 1 {
        bail!(
            "{what} signature matched {} times (game patched?)",
            cursors.len()
        );
    }
    rva_from_cursor(pe, cursors[0])
}

/// The RNG slot-array global. Its signature matches several call sites that
/// must all decode to the same RVA.
pub fn resolve_rng_rva<'a>(pe: impl Pe<'a>) -> Result<u32> {
    let cursors = scan_cursors(pe, RNG_SIG)?;
    // Distinguish "the signature is gone" from "it points at two different
    // globals" — after a game patch these need very different fixes.
    if cursors.is_empty() {
        bail!("rng signature matched 0 times (game patched?)");
    }
    let mut rvas: Vec<u32> = cursors
        .into_iter()
        .map(|c| rva_from_cursor(pe, c))
        .collect::<Result<_>>()?;
    rvas.dedup();
    if rvas.len() != 1 {
        bail!("rng signature resolved to conflicting globals {rvas:x?} (game patched?)");
    }
    Ok(rvas[0])
}

/// Sparse fake memory for walker tests: every byte must have been `put`, so
/// a walker chasing an address the test didn't stage fails loudly.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeMem(std::collections::HashMap<u64, u8>);

#[cfg(test)]
impl FakeMem {
    pub fn put(&mut self, addr: u64, bytes: &[u8]) {
        for (i, b) in bytes.iter().enumerate() {
            self.0.insert(addr + i as u64, *b);
        }
    }
    pub fn put_u32(&mut self, addr: u64, v: u32) {
        self.put(addr, &v.to_le_bytes());
    }
    pub fn put_u64(&mut self, addr: u64, v: u64) {
        self.put(addr, &v.to_le_bytes());
    }
}

#[cfg(test)]
impl MemRead for FakeMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        for (i, out) in buf.iter_mut().enumerate() {
            *out = *self
                .0
                .get(&(addr + i as u64))
                .with_context(|| format!("fake mem: unmapped byte at {:#x}", addr + i as u64))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference sequence computed independently from the decompiled
    /// algorithm (same fixture as the synthesis engine's test).
    #[test]
    fn xorshift32_reference_sequence() {
        let mut s = 1u32;
        let expect = [0x1000a001u32, 0x45000201, 0x451080a1, 0x10150a23];
        for e in expect {
            s = xorshift32(s);
            assert_eq!(s, e);
        }
    }

    const RNG_BASE: u64 = 0x1_4000_0000;
    const RNG_RVA: u32 = 0x2000;
    const RNG_ARRAY: u64 = 0x6000_0000;

    fn rng_world() -> FakeMem {
        let mut m = FakeMem::default();
        m.put_u64(RNG_BASE + RNG_RVA as u64, RNG_ARRAY);
        m.put_u32(RNG_ARRAY + 4 * 4, 0xdead_beef);
        m.put_u32(RNG_ARRAY + RNG_SLOT_OVERRIDE, 0xffff_ffff);
        m
    }

    /// The one read every RNG-backed tool shares: a slot's state plus the
    /// override word, so a prediction can tell an idle stream from a roll
    /// that is mid-flight.
    #[test]
    fn reads_a_slots_state_and_the_override_word() {
        let got = read_rng_slot(&rng_world(), RNG_BASE, RNG_RVA, 4).unwrap();
        assert_eq!(got.state, 0xdead_beef);
        assert_eq!(got.slot_override, 0xffff_ffff);
    }

    #[test]
    fn out_of_range_slot_is_rejected_before_any_read() {
        let err = read_rng_slot(&rng_world(), RNG_BASE, RNG_RVA, RNG_SLOT_COUNT as u32)
            .unwrap_err()
            .to_string();
        assert!(err.contains("out of range"), "{err}");
    }

    #[test]
    fn uninitialized_rng_global_reports_the_title_screen() {
        let mut m = FakeMem::default();
        m.put_u64(RNG_BASE + RNG_RVA as u64, 0);
        let err = read_rng_slot(&m, RNG_BASE, RNG_RVA, 4)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not initialized"), "{err}");
    }

    #[test]
    fn fake_mem_reads_what_was_put_and_fails_elsewhere() {
        let mut m = FakeMem::default();
        m.put_u32(0x1000, 0xdead_beef);
        use crate::MemRead;
        assert_eq!(m.u32(0x1000).unwrap(), 0xdead_beef);
        assert!(m.u32(0x2000).is_err());
    }
}
