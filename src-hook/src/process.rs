use anyhow::anyhow;
use pelite::{
    pattern,
    pe64::{Pe, PeView},
};
use thiserror::Error;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW};

#[derive(Error, Debug)]
pub enum ProcessError {
    #[error("Process was not found with that name")]
    ProcessNotFound,
    #[error("Could not get the host module handle")]
    ModuleHandleError(windows::core::Error),
}

pub struct Process {
    pub base_address: usize,
    pub module_handle: HMODULE,
}

impl Process {
    /// Resolves the process this DLL is running inside, verifying its executable
    /// file name is `name`.
    ///
    /// The hook runs *inside* the game process, so its own loaded-module list
    /// already contains the game image: `GetModuleHandleW(NULL)` returns the
    /// host EXE's base directly. We deliberately do NOT walk the system-wide
    /// process list (`CreateToolhelp32Snapshot`/`Process32*`) — enumerating
    /// every process from within the one we are already in is both pointless
    /// and exactly the behavior AV heuristics score as reconnaissance. The
    /// file-name check preserves the "am I actually in the game?" guard, so an
    /// injection into any other host (e.g. a sandbox's `rundll32`) cleanly
    /// returns `ProcessNotFound` instead of setting up hooks.
    pub fn with_name(name: &str) -> Result<Process, ProcessError> {
        let module_handle =
            unsafe { GetModuleHandleW(None) }.map_err(ProcessError::ModuleHandleError)?;

        if !host_exe_matches(module_handle, name) {
            return Err(ProcessError::ProcessNotFound);
        }

        Ok(Process {
            base_address: module_handle.0 as usize,
            module_handle,
        })
    }

    /// Runs the pelite code scan and returns the capture array (`addrs`) of a single match:
    /// the LAST match when `keep_last` is set, otherwise the FIRST. Shared body of the search
    /// methods below so the scanner/pattern setup lives in one place.
    ///
    /// `addrs[0]` = RVA where the match was found; `addrs[1]` = the first capture (the `'`
    /// cursor, or the `$`-followed call target).
    fn scan(&self, signature_pattern: &str, keep_last: bool) -> anyhow::Result<[u32; 8]> {
        let matches = self.scan_all(signature_pattern, !keep_last)?;
        // `scan_all` errors on an empty result, so there is always a last element.
        Ok(*matches.last().expect("scan_all rejects zero matches"))
    }

    /// Runs the pelite code scan and returns the capture array of every match, in address
    /// order — or just the first when `first_only` is set, which lets single-match callers
    /// keep their early exit instead of walking the rest of the module. The one place the
    /// scanner/pattern setup and the not-found error live.
    fn scan_all(&self, signature_pattern: &str, first_only: bool) -> anyhow::Result<Vec<[u32; 8]>> {
        let view = unsafe { PeView::module(self.module_handle.0 as *const u8) };
        let scanner = view.scanner();
        let pattern = pattern::parse(signature_pattern)?;
        let mut addrs = [0; 8];
        let mut found = Vec::new();
        let mut matches = scanner.matches_code(&pattern);
        while matches.next(&mut addrs) {
            found.push(addrs);
            if first_only {
                break;
            }
        }
        if found.is_empty() {
            return Err(anyhow!(
                "Could not find match for pattern: {}",
                signature_pattern
            ));
        }
        Ok(found)
    }

    /// Runs the pelite code scan and returns the capture array (`addrs`) of the FIRST match.
    fn first_match(&self, signature_pattern: &str) -> anyhow::Result<[u32; 8]> {
        self.scan(signature_pattern, false)
    }

    /// Searches and returns the absolute addresses where the signature begins to match, for
    /// EVERY match (`addrs[0]` of each).
    ///
    /// Unlike the single-match searches above, this is for a signature that is deliberately
    /// non-unique because the same source function was compiled into several sibling
    /// overrides. The 2.0.2 DoT getter is the case in point: `StatusBase::getDotDamage` is a
    /// virtual whose three DoT-dealing subclasses (poison/burn/darkburn) each emit a
    /// byte-identical prologue, so one pattern legitimately resolves to all three entries and
    /// every one of them has to be detoured. Callers should assert the count they expect.
    pub fn search_match_addresses(&self, signature_pattern: &str) -> anyhow::Result<Vec<usize>> {
        Ok(self
            .scan_all(signature_pattern, false)?
            .into_iter()
            .map(|addrs| self.base_address + addrs[0] as usize)
            .collect())
    }

    /// Searches and returns the absolute address of the function that matches the given
    /// signature pattern. Returns the LAST match's followed target (`addrs[1]`); some
    /// signatures in this crate rely on last-match semantics, so that behavior is preserved.
    pub fn search_address(&self, signature_pattern: &str) -> anyhow::Result<usize> {
        Ok(self.base_address + self.scan(signature_pattern, true)?[1] as usize)
    }

    /// Searches and returns the module-relative RVA where the pattern itself begins to match
    /// (`addrs[0]`, the match start — NOT a called function or operand value, and NOT the
    /// cursor `'` capture, which lands in `addrs[1]`; cf. `sigscan`'s `match_rva` vs
    /// `cursor_rva`).
    ///
    /// Used by the `hookdiag` re-derivation flow: a signature that still matches the current
    /// binary (e.g. the `player_data_offset` type-hash site) pins a static point *inside* the
    /// loading code path, which can be fed to Ghidra's FindEntry to recover the enclosing
    /// function — the hook whose own signature no longer matches. The match-start address is
    /// inside the target function, so it serves as a valid FindEntry anchor.
    #[cfg(feature = "hookdiag")]
    pub fn search_match_rva(&self, signature_pattern: &str) -> anyhow::Result<usize> {
        Ok(self.first_match(signature_pattern)?[0] as usize)
    }

    /// Searches and returns the absolute address where the signature itself begins to
    /// match (`addrs[0]`, the match start).
    ///
    /// Unlike [`search_address`](Self::search_address), which follows a captured `call`
    /// target, this is for signatures that match a function's prologue directly — the
    /// match start *is* the entry to detour. Use it when the sig has no `$`/`'` capture.
    pub fn search_match_address(&self, signature_pattern: &str) -> anyhow::Result<usize> {
        Ok(self.base_address + self.first_match(signature_pattern)?[0] as usize)
    }

    /// Searches and returns the value of the type `T` that matches the given signature pattern.
    pub fn search_slice<T>(&self, signature_pattern: &str) -> anyhow::Result<T> {
        let addrs = self.first_match(signature_pattern)?;
        let addr = self.base_address + addrs[1] as usize;
        Ok(unsafe { (addr as *const T).read_unaligned() })
    }
}

/// Whether the host EXE's file name equals `name`, case-insensitively. The path
/// is truncated at the buffer end by `GetModuleFileNameW`, so the buffer is
/// sized well past `MAX_PATH` to keep the trailing file name intact; a zero
/// return (the function's only failure signal) counts as no match.
fn host_exe_matches(module: HMODULE, name: &str) -> bool {
    let mut buf = [0u16; 1024];
    let len = unsafe { GetModuleFileNameW(module, &mut buf) } as usize;
    if len == 0 || len >= buf.len() {
        return false;
    }
    String::from_utf16_lossy(&buf[..len])
        .rsplit(['\\', '/'])
        .next()
        .is_some_and(|file| file.eq_ignore_ascii_case(name))
}
