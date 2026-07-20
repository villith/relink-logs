//! Shared plumbing for reading the running game's memory: process/module
//! discovery, a bounds-checked ReadProcessMemory wrapper, the sigscan
//! resolver for global RVAs, and the RE'd constants common to every feature
//! (the per-slot RNG and the "empty" sentinel).
//!
//! Feature modules (synthesis, overmastery) keep their own signatures and
//! struct offsets; everything process- or RNG-array-shaped lives here so a
//! game patch is fixed in one place.

use anyhow::{bail, Context, Result};
use dll_syringe::process::{OwnedProcess, Process};
use pelite::pattern;
use pelite::pe64::{Pe, PeFile};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

/// The game process/module name, shared with the injector in main.rs.
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

pub struct Mem(pub HANDLE);

impl Mem {
    pub fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
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
    pub fn u64(&self, addr: u64) -> Result<u64> {
        let mut b = [0u8; 8];
        self.read(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    pub fn u32(&self, addr: u64) -> Result<u32> {
        let mut b = [0u8; 4];
        self.read(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    pub fn i32(&self, addr: u64) -> Result<i32> {
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
pub fn find_game_pid() -> Result<Option<u32>> {
    let Some(process) = OwnedProcess::find_first_by_name(GAME_EXE) else {
        return Ok(None);
    };
    Ok(Some(process.pid().context("query game pid")?.get()))
}

/// Main-module (exe) base address and on-disk path.
pub fn module_base(pid: u32) -> Result<(u64, PathBuf)> {
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

/// Open the running game for reading: process handle + exe base + exe path.
/// `Ok(None)` = game not running.
pub fn open_game() -> Result<Option<(Mem, u64, PathBuf)>> {
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(
        unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
            .context("OpenProcess (run as admin?)")?,
    );
    let (base, exe) = module_base(pid)?;
    Ok(Some((mem, base, exe)))
}

/// Decode the rip-relative disp32 a signature cursor points at:
/// global RVA = cursor + 4 + disp.
pub fn rva_from_cursor(pe: &PeFile, cursor: u32) -> Result<u32> {
    let bytes: [u8; 4] = pe
        .derva_slice::<u8>(cursor, 4)
        .map_err(|e| anyhow::anyhow!("derva {cursor:#x}: {e:?}"))?
        .try_into()
        .expect("slice length is 4");
    Ok(cursor.wrapping_add(4).wrapping_add(u32::from_le_bytes(bytes)))
}

/// All cursor RVAs matching `sig` (the pattern's save slot 1).
pub fn scan_cursors(pe: &PeFile, sig: &str) -> Result<Vec<u32>> {
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
pub fn scan_unique_rva(pe: &PeFile, sig: &str, what: &str) -> Result<u32> {
    let cursors = scan_cursors(pe, sig)?;
    if cursors.len() != 1 {
        bail!("{what} signature matched {} times (game patched?)", cursors.len());
    }
    rva_from_cursor(pe, cursors[0])
}

/// The RNG slot-array global. Its signature matches several call sites that
/// must all decode to the same RVA.
pub fn resolve_rng_rva(pe: &PeFile) -> Result<u32> {
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

/// Sigscan the on-disk exe for a feature's global RVAs, cached in the
/// caller's `cache` per exe path (the exe only changes on a game patch,
/// which needs a restart).
///
/// A `Mutex<Option<..>>` and not a `OnceLock`: the cache is keyed by exe
/// path, and a `OnceLock` can never be re-keyed — once filled, `set` on a
/// different path fails silently and every later call would re-read and
/// re-scan the ~120 MB exe, including the 5s staleness polls.
pub fn resolve_globals_cached<const N: usize>(
    cache: &Mutex<Option<(PathBuf, [u32; N])>>,
    exe: &Path,
    resolve: impl FnOnce(&PeFile) -> Result<[u32; N]>,
) -> Result<[u32; N]> {
    // A poisoned lock only means some other caller panicked mid-scan; the
    // cached value is still just a path and three RVAs.
    if let Some((p, rvas)) = cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if p == exe {
            return Ok(*rvas);
        }
    }
    let data = std::fs::read(exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;
    let rvas = resolve(&pe)?;
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((exe.to_path_buf(), rvas));
    Ok(rvas)
}
