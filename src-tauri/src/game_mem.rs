//! Diag-only RPM plumbing: open the running game with OpenProcess /
//! ReadProcessMemory and take toolbox snapshots from OUTSIDE the process.
//!
//! The production path no longer lives here — the hook serves snapshots
//! in-process over the toolbox RPC channel (see `toolbox_rpc`). This module
//! remains for the ground-truth probes in examples/ (om_probe, synth_probe,
//! synth_diag, toolbox_probe), which deliberately read the same structures
//! through a channel that shares no hook code, so they can cross-check it.
//! Windows-only, requires admin, reads the on-disk exe for sigscanning.

use anyhow::{bail, Context, Result};
use dll_syringe::process::{OwnedProcess, Process};
use game_reader::MemRead;
use pelite::pe64::PeFile;
use std::path::PathBuf;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

pub use game_reader::GAME_EXE;

pub struct Mem(pub HANDLE);

impl MemRead for Mem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
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
/// `Ok(None)` = game not running. Uncached — the probes are one-shot tools;
/// the old cache existed for the app's 5-second staleness pollers, which now
/// go through the hook instead.
pub fn open_game() -> Result<Option<(Mem, u64, PathBuf)>> {
    let Some(pid) = find_game_pid()? else {
        return Ok(None);
    };
    let mem = Mem(unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) }
        .context("OpenProcess (run as admin?)")?);
    let (base, exe) = module_base(pid)?;
    Ok(Some((mem, base, exe)))
}

/// RPM synthesis snapshot (probe ground truth). `Ok(None)` = game not running.
pub fn rpm_synthesis_snapshot() -> Result<Option<protocol::toolbox::SynthesisSnapshot>> {
    let Some((mem, base, exe)) = open_game()? else {
        return Ok(None);
    };
    let data = std::fs::read(&exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;
    let rvas = game_reader::synthesis::resolve_rvas(pe)?;
    Ok(Some(game_reader::synthesis::take_snapshot(&mem, base, rvas)?))
}

/// RPM overmastery snapshot (probe ground truth). `Ok(None)` = game not running.
pub fn rpm_overmastery_snapshot() -> Result<Option<protocol::toolbox::OvermasterySnapshot>> {
    let Some((mem, base, exe)) = open_game()? else {
        return Ok(None);
    };
    let data = std::fs::read(&exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = PeFile::from_bytes(&data).context("parse exe")?;
    let rvas = game_reader::overmastery::resolve_rvas(pe)?;
    Ok(Some(game_reader::overmastery::take_snapshot(&mem, base, rvas)?))
}
