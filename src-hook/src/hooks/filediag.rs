//! hookdiag-only file-open tracing (feature `hookdiag`, off by default).
//!
//! Detours `CreateFileW`/`CreateFileA` in the game process and logs every open whose
//! path mentions the quest or table data we mod (`quest`, `endless`, `system/table`).
//! Purpose: determine whether the game actually opens loose external files under
//! `data/` for a given asset class. The `system/table` opens are the positive control
//! (table overrides demonstrably apply in-game); if those appear but
//! `data/quest/ex/<room>/baseinfo.msg` never does, the quest files are served from the
//! archive/chunk cache and loose-file overrides cannot affect them.
//!
//! Everything compiles to a no-op without `--features hookdiag`.

use anyhow::Result;

#[cfg(feature = "hookdiag")]
mod imp {
    use anyhow::{anyhow, Result};
    use retour::static_detour;
    use windows::core::PCSTR;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};

    // HANDLE CreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE)
    type CreateFileWFn =
        unsafe extern "system" fn(*const u16, u32, u32, usize, u32, u32, usize) -> usize;
    type CreateFileAFn =
        unsafe extern "system" fn(*const u8, u32, u32, usize, u32, u32, usize) -> usize;

    static_detour! {
        static OnCreateFileW: unsafe extern "system" fn(*const u16, u32, u32, usize, u32, u32, usize) -> usize;
        static OnCreateFileA: unsafe extern "system" fn(*const u8, u32, u32, usize, u32, u32, usize) -> usize;
    }

    /// The path fragments worth logging. All ASCII, which is what lets the tests below
    /// run over the caller's raw buffer.
    const NEEDLES: [&str; 4] = ["quest", "endless", "system\\table", "system/table"];

    /// These detours cover EVERY file the process opens — thousands a second during asset
    /// streaming — and reject essentially all of them. So the interest test runs over the
    /// caller's buffer, case-insensitively and in place; only a path that already matched
    /// is decoded into a `String` to be logged.
    fn interesting_bytes(path: &[u8]) -> bool {
        NEEDLES.iter().any(|needle| {
            let n = needle.as_bytes();
            path.len() >= n.len() && path.windows(n.len()).any(|window| window.eq_ignore_ascii_case(n))
        })
    }

    fn interesting_wide(path: &[u16]) -> bool {
        NEEDLES.iter().any(|needle| {
            let n = needle.as_bytes();
            path.len() >= n.len()
                && path.windows(n.len()).any(|window| {
                    window
                        .iter()
                        .zip(n)
                        .all(|(&unit, byte)| unit < 0x80 && (unit as u8).eq_ignore_ascii_case(byte))
                })
        })
    }

    fn on_create_file_w(
        name: *const u16,
        access: u32,
        share: u32,
        sa: usize,
        disp: u32,
        flags: u32,
        templ: usize,
    ) -> usize {
        if !name.is_null() {
            let mut len = 0usize;
            // SAFETY: CreateFileW contract guarantees a NUL-terminated wide string.
            unsafe {
                while *name.add(len) != 0 && len < 1024 {
                    len += 1;
                }
                let path = std::slice::from_raw_parts(name, len);
                if interesting_wide(path) {
                    log::info!(
                        "HOOKDIAG ev=file_open api=W path={}",
                        String::from_utf16_lossy(path)
                    );
                }
            }
        }
        unsafe { OnCreateFileW.call(name, access, share, sa, disp, flags, templ) }
    }

    fn on_create_file_a(
        name: *const u8,
        access: u32,
        share: u32,
        sa: usize,
        disp: u32,
        flags: u32,
        templ: usize,
    ) -> usize {
        if !name.is_null() {
            let mut len = 0usize;
            // SAFETY: CreateFileA contract guarantees a NUL-terminated string.
            unsafe {
                while *name.add(len) != 0 && len < 1024 {
                    len += 1;
                }
                let path = std::slice::from_raw_parts(name, len);
                if interesting_bytes(path) {
                    log::info!(
                        "HOOKDIAG ev=file_open api=A path={}",
                        String::from_utf8_lossy(path)
                    );
                }
            }
        }
        unsafe { OnCreateFileA.call(name, access, share, sa, disp, flags, templ) }
    }

    pub fn setup() -> Result<()> {
        unsafe {
            let k32 = GetModuleHandleA(PCSTR(b"kernel32.dll\0".as_ptr()))?;
            let w = GetProcAddress(k32, PCSTR(b"CreateFileW\0".as_ptr()))
                .ok_or_else(|| anyhow!("CreateFileW not found"))?;
            let a = GetProcAddress(k32, PCSTR(b"CreateFileA\0".as_ptr()))
                .ok_or_else(|| anyhow!("CreateFileA not found"))?;
            OnCreateFileW
                .initialize(
                    std::mem::transmute::<_, CreateFileWFn>(w),
                    on_create_file_w,
                )?
                .enable()?;
            OnCreateFileA
                .initialize(
                    std::mem::transmute::<_, CreateFileAFn>(a),
                    on_create_file_a,
                )?
                .enable()?;
        }
        Ok(())
    }
}

/// Install the file-open tracer. No-op without the `hookdiag` feature.
pub fn setup() -> Result<()> {
    #[cfg(feature = "hookdiag")]
    {
        imp::setup()
    }
    #[cfg(not(feature = "hookdiag"))]
    {
        Ok(())
    }
}
