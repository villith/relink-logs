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

pub mod overmastery;
pub mod synthesis;

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

    #[test]
    fn fake_mem_reads_what_was_put_and_fails_elsewhere() {
        let mut m = FakeMem::default();
        m.put_u32(0x1000, 0xdead_beef);
        use crate::MemRead;
        assert_eq!(m.u32(0x1000).unwrap(), 0xdead_beef);
        assert!(m.u32(0x2000).is_err());
    }
}
