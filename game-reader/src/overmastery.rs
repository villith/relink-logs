//! Read-only snapshot of the game's meditation RNG state: the RNG slot array
//! and the character roster vector (character -> slot index).

use crate::{resolve_rng_rva, scan_unique_rva, MemRead, RNG_SLOT_COUNT};
use anyhow::{bail, Result};
use pelite::pe64::Pe;
pub use protocol::toolbox::OvermasterySnapshot;

/// Anchored on the PL0100/PL0000 id compares inside the meditation roll
/// (FUN_141beb1b0); cursor lands on the disp32 of `mov rax, [rip+disp]`
/// loading the character roster global.
const ROSTER_SIG: &str = "81 f9 76 ba ac a4 74 ? 81 f9 b2 b1 26 2a 75 ? 8d 0c 9b 44 8d 04 cb 42 8d 14 00 83 c2 05 48 8b 0d ? ? ? ? 83 fa ff 74 ? 44 01 c0 83 f8 7d 7f ? eb ? 48 8b 05 ' ? ? ? ?";

const MAX_ROSTER: u64 = 64;

/// The two globals overmastery needs, as module-relative RVAs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OvermasteryRvas {
    pub rng: u32,
    pub roster: u32,
}

/// Sigscan for the RNG and roster globals (PeFile or PeView alike).
pub fn resolve_rvas<'a>(pe: impl Pe<'a>) -> Result<OvermasteryRvas> {
    Ok(OvermasteryRvas {
        rng: resolve_rng_rva(pe)?,
        roster: scan_unique_rva(pe, ROSTER_SIG, "roster")?,
    })
}

fn deref_rng(mem: &impl MemRead, base: u64, rvas: OvermasteryRvas) -> Result<u64> {
    let rng = mem.u64(base + rvas.rng as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }
    Ok(rng)
}

/// Light read of one RNG slot's state (`slot` < `RNG_SLOT_COUNT`) for
/// staleness polling — a single 4-byte read, no roster walk.
pub fn take_slot_state(
    mem: &impl MemRead,
    base: u64,
    rvas: OvermasteryRvas,
    slot: u32,
) -> Result<u32> {
    if slot as usize >= RNG_SLOT_COUNT {
        bail!("slot {slot:#x} out of range");
    }
    let rng = deref_rng(mem, base, rvas)?;
    mem.u32(rng + slot as u64 * 4)
}

/// Take a meditation RNG snapshot.
pub fn take_snapshot(
    mem: &impl MemRead,
    base: u64,
    rvas: OvermasteryRvas,
) -> Result<OvermasterySnapshot> {
    let rng = deref_rng(mem, base, rvas)?;

    let mut block = vec![0u8; RNG_SLOT_COUNT * 4 + 4];
    mem.read(rng, &mut block)?;
    let word = |i: usize| u32::from_le_bytes(block[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    let slots: Vec<u32> = (0..RNG_SLOT_COUNT).map(word).collect();
    // RNG_SLOT_OVERRIDE == RNG_SLOT_COUNT * 4 is asserted at compile time in
    // the crate root, so the override word is simply the slot after the last.
    let slot_override = word(RNG_SLOT_COUNT);

    // The global holds a pointer to the roster object; the id vector's
    // begin/end pointers sit at +8 / +0x10 of THAT object.
    let roster_obj = mem.u64(base + rvas.roster as u64)?;
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

    Ok(OvermasterySnapshot {
        slots,
        slot_override,
        roster,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FakeMem, RNG_SLOT_OVERRIDE};

    const BASE: u64 = 0x1_4000_0000;
    const RVAS: OvermasteryRvas = OvermasteryRvas {
        rng: 0x2000,
        roster: 0x3000,
    };
    const RNG: u64 = 0x6000_0000;
    const ROSTER_OBJ: u64 = 0x8000_0000;
    const IDS: u64 = 0x8000_1000;

    fn valid_world() -> FakeMem {
        let mut m = FakeMem::default();
        m.put_u64(BASE + RVAS.rng as u64, RNG);
        for i in 0..RNG_SLOT_COUNT {
            m.put_u32(RNG + i as u64 * 4, i as u32 + 100);
        }
        m.put_u32(RNG + RNG_SLOT_OVERRIDE, u32::MAX);
        m.put_u64(BASE + RVAS.roster as u64, ROSTER_OBJ);
        m.put_u64(ROSTER_OBJ + 8, IDS);
        m.put_u64(ROSTER_OBJ + 0x10, IDS + 8); // two ids
        m.put_u32(IDS, 0xaaaa);
        m.put_u32(IDS + 4, 0xbbbb);
        m
    }

    #[test]
    fn snapshot_reads_slots_override_and_roster() {
        let snap = take_snapshot(&valid_world(), BASE, RVAS).unwrap();
        assert_eq!(snap.slots.len(), RNG_SLOT_COUNT);
        assert_eq!(snap.slots[0x81], 0x81 + 100);
        assert_eq!(snap.slot_override, u32::MAX);
        assert_eq!(snap.roster, vec![0xaaaa, 0xbbbb]);
    }

    #[test]
    fn torn_roster_vector_fails() {
        let mut m = valid_world();
        m.put_u64(ROSTER_OBJ + 0x10, IDS - 8); // end < begin
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("torn"), "{err}");
    }

    #[test]
    fn slot_state_reads_one_slot_and_bounds_checks() {
        let m = valid_world();
        assert_eq!(take_slot_state(&m, BASE, RVAS, 2).unwrap(), 102);
        let err = take_slot_state(&m, BASE, RVAS, RNG_SLOT_COUNT as u32)
            .unwrap_err()
            .to_string();
        assert!(err.contains("out of range"), "{err}");
    }

    #[test]
    fn null_rng_global_fails_with_title_screen_hint() {
        let mut m = valid_world();
        m.put_u64(BASE + RVAS.rng as u64, 0);
        let err = take_snapshot(&m, BASE, RVAS).unwrap_err().to_string();
        assert!(err.contains("title screen"), "{err}");
    }
}
