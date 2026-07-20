//! Read-only snapshot of the game's meditation RNG state via ReadProcessMemory.
//!
//! The meditation roll is a pure function of the baked tables plus a
//! per-(character, size) RNG slot, so the snapshot only needs the RNG slot
//! array and the character roster vector (for character -> slot index).
//! Globals are resolved by sigscanning the on-disk exe (pelite), cached per
//! exe path — same approach as synthesis::snapshot.

use crate::synthesis::snapshot::{find_game_pid, module_base, Mem, RNG_SIG};
use anyhow::{bail, Context, Result};
use pelite::pattern;
use pelite::pe64::{Pe, PeFile};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

/// Number of RNG slots (0..=0x82); the override word sits right after them.
pub const RNG_SLOT_COUNT: usize = 0x83;
const RNG_SLOT_OVERRIDE: u64 = 0x20c;

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

/// Sigscan the on-disk exe for the RNG and roster globals. Cached for the
/// process lifetime (the exe only changes on a game patch).
fn resolve_globals(exe: &Path) -> Result<(u32, u32)> {
    static CACHE: OnceLock<(PathBuf, (u32, u32))> = OnceLock::new();
    if let Some((p, rvas)) = CACHE.get() {
        if p == exe {
            return Ok(*rvas);
        }
    }
    let data = std::fs::read(exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;

    let rva_from_cursor = |cursor: u32| -> Result<u32> {
        let bytes: [u8; 4] = pe
            .derva_slice::<u8>(cursor, 4)
            .map_err(|e| anyhow::anyhow!("derva {cursor:#x}: {e:?}"))?
            .try_into()
            .expect("slice length is 4");
        Ok(cursor.wrapping_add(4).wrapping_add(u32::from_le_bytes(bytes)))
    };

    let scan = |sig: &str| -> Result<Vec<u32>> {
        let pat = pattern::parse(sig).context("parse pattern")?;
        let mut out = Vec::new();
        let mut matches = pe.scanner().matches_code(&pat);
        let mut save = [0u32; 8];
        while matches.next(&mut save) {
            out.push(save[1]);
        }
        Ok(out)
    };

    let mut rng_rvas: Vec<u32> = scan(RNG_SIG)?
        .into_iter()
        .map(rva_from_cursor)
        .collect::<Result<_>>()?;
    rng_rvas.dedup();
    if rng_rvas.len() != 1 {
        bail!("rng signature resolved to {rng_rvas:x?} (game patched?)");
    }

    let roster = scan(ROSTER_SIG)?;
    if roster.len() != 1 {
        bail!("roster signature matched {} times (game patched?)", roster.len());
    }
    let rvas = (rng_rvas[0], rva_from_cursor(roster[0])?);
    let _ = CACHE.set((exe.to_path_buf(), rvas));
    Ok(rvas)
}

/// Take a meditation RNG snapshot. `Ok(None)` = game not running.
pub fn take_snapshot() -> Result<Option<OvermasterySnapshot>> {
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(
        unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
            .context("OpenProcess (run as admin?)")?,
    );
    let (base, exe) = module_base(pid)?;
    let (rng_rva, roster_rva) = resolve_globals(&exe)?;

    let rng = mem.u64(base + rng_rva as u64)?;
    if rng == 0 {
        bail!("rng global not initialized yet (still on title screen?)");
    }

    let mut block = vec![0u8; RNG_SLOT_COUNT * 4 + 4];
    mem.read(rng, &mut block)?;
    let word = |i: usize| u32::from_le_bytes(block[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    let slots: Vec<u32> = (0..RNG_SLOT_COUNT).map(word).collect();
    debug_assert_eq!(RNG_SLOT_OVERRIDE as usize, RNG_SLOT_COUNT * 4);
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
    let mut roster = Vec::with_capacity(count as usize);
    for i in 0..count {
        roster.push(mem.u32(begin + i * 4)?);
    }

    Ok(Some(OvermasterySnapshot { slots, slot_override, roster }))
}
