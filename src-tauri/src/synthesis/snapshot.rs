//! Read-only snapshot of the game's synthesis state via ReadProcessMemory.
//!
//! Global RVAs are resolved by sigscanning the exe on disk (pelite), cached
//! per exe path. All reads are bounds-checked; a torn/absurd read fails the
//! snapshot rather than producing wrong predictions.

use super::{SynthesisSigil, SynthesisSnapshot};
use anyhow::{bail, Context, Result};
use pelite::pattern;
use pelite::pe64::{Pe, PeFile};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use dll_syringe::process::{OwnedProcess, Process};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

const GAME_EXE: &str = "granblue_fantasy_relink.exe";

// Cursor lands on the disp32 of `mov rdi/rcx, [rip+disp]`; global RVA = cursor + 4 + disp.
const COMMIT_SIG: &str = "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec ? ? 00 00 48 8d ac 24 80 00 00 00 48 c7 85 ? ? 00 00 fe ff ff ff 48 8b 3d ' ? ? ? ? 48 8b 05";
pub(crate) const RNG_SIG: &str = "48 8b 0d ' ? ? ? ? ba 81 00 00 00 e8";

// Sigil-manager struct offsets (v2.0.2 layout; see the plan's offset table).
const MGR_ITEM_MAP: u64 = 0x0;
const MGR_WEIGHT_MAP: u64 = 0x180;
const MGR_TRAIT_ITEM_MAP: u64 = 0x240;
const MGR_SEED_COUNTER: u64 = 0x2d8;
const MGR_PAIR_MAP: u64 = 0x2e0;
const MGR_UID_MAP: u64 = 0x37f80;
const RNG_SYNTH_STATE: u64 = 0x81 * 4; // slot 0x81
const RNG_SLOT_OVERRIDE: u64 = 0x20c;

const MAX_MAP_ENTRIES: u64 = 500_000;

pub(crate) struct Mem(pub(crate) HANDLE);

impl Mem {
    pub(crate) fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        let mut got = 0usize;
        unsafe {
            ReadProcessMemory(
                self.0,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                buf.len(),
                Some(&mut got),
            )
        }
        .ok()
        .with_context(|| format!("read {:#x} ({} bytes)", addr, buf.len()))?;
        if got != buf.len() {
            bail!("short read at {addr:#x}");
        }
        Ok(())
    }
    pub(crate) fn u64(&self, addr: u64) -> Result<u64> {
        let mut b = [0u8; 8];
        self.read(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    pub(crate) fn u32(&self, addr: u64) -> Result<u32> {
        let mut b = [0u8; 4];
        self.read(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn i32(&self, addr: u64) -> Result<i32> {
        Ok(self.u32(addr)? as i32)
    }
}

impl Drop for Mem {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

/// Find the game process id, or None if it isn't running. Uses the same
/// dll_syringe lookup as the injector (`check_and_perform_hook` in main.rs).
pub(crate) fn find_game_pid() -> Result<Option<u32>> {
    let Some(process) = OwnedProcess::find_first_by_name(GAME_EXE) else {
        return Ok(None);
    };
    Ok(Some(process.pid().context("query game pid")?.get()))
}

/// Main-module (exe) base address and on-disk path.
pub(crate) fn module_base(pid: u32) -> Result<(u64, PathBuf)> {
    let snap = Mem(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) }?);
    let mut entry = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe { Module32FirstW(snap.0, &mut entry) }.context("Module32FirstW")?;
    Ok((
        entry.modBaseAddr as u64,
        PathBuf::from(wide_to_string(&entry.szExePath)),
    ))
}

/// Sigscan the on-disk exe for the two globals. Cached for the process
/// lifetime (the exe only changes on a game patch, which needs a restart).
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

    let commit = scan(COMMIT_SIG)?;
    if commit.len() != 1 {
        bail!("commit signature matched {} times (game patched?)", commit.len());
    }
    let mgr_rva = rva_from_cursor(commit[0])?;

    let rng_cursors = scan(RNG_SIG)?;
    if rng_cursors.is_empty() {
        bail!("rng signature matched 0 times (game patched?)");
    }
    let mut rng_rvas = Vec::new();
    for c in rng_cursors {
        rng_rvas.push(rva_from_cursor(c)?);
    }
    rng_rvas.dedup();
    if rng_rvas.len() != 1 {
        bail!("rng signature resolved to conflicting globals {rng_rvas:x?}");
    }
    let rvas = (mgr_rva, rng_rvas[0]);
    let _ = CACHE.set((exe.to_path_buf(), rvas));
    Ok(rvas)
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
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(
        unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
            .context("OpenProcess (run as admin?)")?,
    );
    let (base, exe) = module_base(pid)?;
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
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(
        unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
            .context("OpenProcess (run as admin?)")?,
    );
    let (base, exe) = module_base(pid)?;
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
            snap.level_weights.insert(key, (mem.u32(val)?, mem.u32(val + 4)?));
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
