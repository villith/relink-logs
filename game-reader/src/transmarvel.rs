//! Read-only snapshot of the game's transmarvel RNG state.

use crate::{deref_rng, resolve_rng_rva, MemRead, RNG_SLOT_COUNT, RNG_SLOT_OVERRIDE};
use anyhow::Result;
use pelite::pe64::Pe;
pub use protocol::toolbox::TransmarvelSnapshot;

/// RNG slot the transmarvel roll draws from. The roll (GemGacha exec,
/// FUN_141bb6610 v2.0.2) sets the slot-override word to the gacha row's
/// slot base + 1 — transmutation Lv1-3 use slots 1-3, transmarvel uses 4 —
/// so every draw inside the roll lands here.
pub const TM_SLOT: u64 = 4;

/// Globals transmarvel needs, as module-relative RVAs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransmarvelRvas {
    pub rng: u32,
}

pub fn resolve_rvas<'a>(pe: impl Pe<'a>) -> Result<TransmarvelRvas> {
    Ok(TransmarvelRvas {
        rng: resolve_rng_rva(pe)?,
    })
}

pub fn take_snapshot(
    mem: &impl MemRead,
    base: u64,
    rvas: TransmarvelRvas,
) -> Result<TransmarvelSnapshot> {
    let rng = deref_rng(mem, base, rvas.rng)?;
    Ok(TransmarvelSnapshot {
        rng_state: mem.u32(rng + TM_SLOT * 4)?,
        slot_override: mem.u32(rng + RNG_SLOT_OVERRIDE)?,
    })
}

// Keep the constant honest against the array bounds.
const _: () = assert!((TM_SLOT as usize) < RNG_SLOT_COUNT);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FakeMem;

    const BASE: u64 = 0x1_4000_0000;
    const RVAS: TransmarvelRvas = TransmarvelRvas { rng: 0x2000 };
    const RNG: u64 = 0x6000_0000;

    fn valid_world() -> FakeMem {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.rng as u64, RNG);
        m.put_u32(RNG + TM_SLOT * 4, 0xdead_beef);
        m.put_u32(RNG + RNG_SLOT_OVERRIDE, 0xffff_ffff);
        m
    }

    #[test]
    fn snapshot_reads_slot_and_override() {
        let snap = take_snapshot(&valid_world(), BASE, RVAS).unwrap();
        assert_eq!(snap.rng_state, 0xdead_beef);
        assert_eq!(snap.slot_override, 0xffff_ffff);
    }

    #[test]
    fn uninitialized_rng_global_fails_cleanly() {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.rng as u64, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("not initialized"), "{err}");
    }

    #[test]
    fn unmapped_slot_memory_fails_not_faults() {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.rng as u64, RNG); // slots themselves unmapped
        assert!(take_snapshot(&m, BASE, RVAS).is_err());
    }
}
