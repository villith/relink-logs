//! dinput8 proxy export.
//!
//! Under Proton the hook is deployed into the game directory as
//! `dinput8.dll` and loaded at game start via
//! `WINEDLLOVERRIDES="dinput8=n,b"` — the game statically imports
//! DirectInput8Create, which we forward to the real system dinput8 (loaded
//! by explicit system32 path, so Wine resolves its builtin). On Windows the
//! DLL is injected as hook.dll and this export is never called. Loading is
//! all `#[ctor]` needs, so no other change is required for the proxy path.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::core::{s, w, HRESULT};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

type DirectInput8CreateFn = unsafe extern "system" fn(
    hinst: HMODULE,
    version: u32,
    riid: *const c_void,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> HRESULT;

static REAL: OnceLock<Option<DirectInput8CreateFn>> = OnceLock::new();

fn real_create() -> Option<DirectInput8CreateFn> {
    *REAL.get_or_init(|| unsafe {
        let module = LoadLibraryW(w!(r"C:\windows\system32\dinput8.dll")).ok()?;
        let addr = GetProcAddress(module, s!("DirectInput8Create"))?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            DirectInput8CreateFn,
        >(addr))
    })
}

/// # Safety
/// Called by the loader/game with dinput8's documented ABI; pointers are
/// passed through untouched.
#[no_mangle]
pub unsafe extern "system" fn DirectInput8Create(
    hinst: HMODULE,
    version: u32,
    riid: *const c_void,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> HRESULT {
    match real_create() {
        Some(real) => real(hinst, version, riid, out, outer),
        // E_FAIL — no real dinput8, unreachable on any Windows or Wine.
        None => HRESULT(0x80004005u32 as i32),
    }
}
