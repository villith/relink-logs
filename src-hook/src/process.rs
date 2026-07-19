use anyhow::anyhow;
use pelite::{
    pattern,
    pe64::{Pe, PeView},
};
use thiserror::Error;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Process32FirstW, Process32NextW, MODULEENTRY32W,
    PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
};

#[derive(Error, Debug)]
pub enum ProcessError {
    #[error("Process was not found with that name")]
    ProcessNotFound,
    #[error("Could not snapshot process")]
    ProcessSnapshotError(windows::core::Error),
    #[error("Could not snapshot process memory")]
    ModuleSnapshotError(windows::core::Error),
}

pub struct Process {
    pub base_address: usize,
    pub module_handle: HMODULE,
}

impl Process {
    /// Finds a process by its name.
    pub fn with_name(name: &str) -> Result<Process, ProcessError> {
        let mut found_process = None;

        unsafe {
            let snapshot_handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
                .map_err(ProcessError::ProcessSnapshotError)?;

            let mut process = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..PROCESSENTRY32W::default()
            };

            if Process32FirstW(snapshot_handle, &mut process).is_ok() {
                loop {
                    if Process32NextW(snapshot_handle, &mut process).is_ok() {
                        let process_name = String::from_utf16_lossy(&process.szExeFile)
                            .trim_end_matches('\u{0}')
                            .to_string();

                        if process_name == name {
                            let module_snapshot = CreateToolhelp32Snapshot(
                                TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                process.th32ProcessID,
                            )
                            .map_err(ProcessError::ModuleSnapshotError)?;

                            let mut module_entry = MODULEENTRY32W {
                                dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
                                ..MODULEENTRY32W::default()
                            };

                            if Module32FirstW(module_snapshot, &mut module_entry).is_ok() {
                                let module_name = String::from_utf16_lossy(&process.szExeFile)
                                    .trim_end_matches('\u{0}')
                                    .to_string();

                                if module_name == name {
                                    let base_address = module_entry.modBaseAddr as usize;
                                    let module_handle = module_entry.hModule;

                                    found_process = Some(Process {
                                        base_address,
                                        module_handle,
                                    });
                                }
                            } else {
                                break;
                            }
                        }
                    } else {
                        break;
                    }
                }
            }
        }

        found_process.ok_or(ProcessError::ProcessNotFound)
    }

    /// Runs the pelite code scan and returns the capture array (`addrs`) of a single match:
    /// the LAST match when `keep_last` is set, otherwise the FIRST. Shared body of the search
    /// methods below so the scanner/pattern setup lives in one place.
    ///
    /// `addrs[0]` = RVA where the match was found; `addrs[1]` = the first capture (the `'`
    /// cursor, or the `$`-followed call target).
    fn scan(&self, signature_pattern: &str, keep_last: bool) -> anyhow::Result<[u32; 8]> {
        let view = unsafe { PeView::module(self.module_handle.0 as *const u8) };
        let scanner = view.scanner();
        let pattern = pattern::parse(signature_pattern)?;
        let mut addrs = [0; 8];
        let mut found = None;
        let mut matches = scanner.matches_code(&pattern);
        while matches.next(&mut addrs) {
            found = Some(addrs);
            if !keep_last {
                break;
            }
        }
        found.ok_or(anyhow!(
            "Could not find match for pattern: {}",
            signature_pattern
        ))
    }

    /// Runs the pelite code scan and returns the capture array (`addrs`) of the FIRST match.
    fn first_match(&self, signature_pattern: &str) -> anyhow::Result<[u32; 8]> {
        self.scan(signature_pattern, false)
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
