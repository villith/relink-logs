//! Live-capture probe for re-deriving the broken `player_load` hook (feature `hookdiag`).
//!
//! Post-2.0.2 the `player_load` function's own signature no longer matches and it cannot
//! be recovered statically: its only surviving anchor (the `0x887ae0b0` player-data
//! type-hash) lives inside a GENERIC component-lookup dispatcher (`FUN_14092f2d0`, a clean
//! 2-arg entry confirmed in Ghidra), not inside the loader. So we turn it around at runtime:
//! we detour that dispatcher and, on the calls that look up the player-data component
//! (`edx == 0x887ae0b0`), walk the return-address stack. The frame directly above the
//! dispatcher is the code that fetches player data during load — i.e. `player_load` (or its
//! immediate caller), whose RVA we log for FindEntry. A handful of captures is enough, so we
//! rate-limit hard to avoid flooding the log / perturbing timing.
//!
//! Compiles to nothing without `--features hookdiag`.

#[cfg(feature = "hookdiag")]
pub use imp::OnComponentLookupProbe;

#[cfg(not(feature = "hookdiag"))]
pub struct OnComponentLookupProbe;

#[cfg(not(feature = "hookdiag"))]
impl OnComponentLookupProbe {
    pub fn new() -> Self {
        Self
    }
    pub fn setup(&self, _process: &crate::process::Process) -> anyhow::Result<()> {
        Ok(())
    }
}

#[cfg(feature = "hookdiag")]
mod imp {
    use std::sync::atomic::AtomicU32;

    use anyhow::{anyhow, Result};
    use retour::static_detour;

    use crate::process::Process;

    /// The player-data component type-hash. When the dispatcher is called with this key,
    /// the caller is fetching player data — the exact moment adjacent to `player_load`.
    const PLAYER_DATA_TYPE_HASH: u32 = 0x887ae0b0;

    /// Direct-entry signature for the generic component-lookup dispatcher `FUN_14092f2d0`.
    /// Verified unique via `sigscan ... addr` → target_rva=0x92f2d0. `cc cc '` anchors on the
    /// int3 padding before the entry; the tail includes the distinctive body bytes so the
    /// common `push rbp; ... sub rsp,0x3d8` prologue (12 matches alone) is disambiguated.
    const DISPATCHER_SIG: &str = "cc cc ' 55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec d8 03 00 00 48 8d ac 24 80 00 00 00 48 c7 85 50 03 00 00 fe ff ff ff 89 d6 49 89 ce 8b 91 28 31 00 00";

    /// Only capture the first few matching backtraces — the caller RVA is stable, so more
    /// captures add nothing but log spam and per-call unwinding overhead.
    const MAX_CAPTURES: u32 = 4;
    static CAPTURES: AtomicU32 = AtomicU32::new(0);

    /// Diagnostic: log the `edx` (type-hash) of the FIRST N dispatcher calls unconditionally,
    /// to learn which hashes actually flow through this function. If 0x887ae0b0 never appears,
    /// player_load does not fetch player-data via this dispatcher and we need another anchor.
    const MAX_HASH_LOGS: u32 = 30;
    static HASH_LOGS: AtomicU32 = AtomicU32::new(0);

    type DispatcherFunc = unsafe extern "system" fn(*const usize, u32) -> *const usize;

    static_detour! {
        static Dispatcher: unsafe extern "system" fn(*const usize, u32) -> *const usize;
    }

    #[derive(Clone)]
    pub struct OnComponentLookupProbe;

    impl OnComponentLookupProbe {
        pub fn new() -> Self {
            Self
        }

        pub fn setup(&self, process: &Process) -> Result<()> {
            let addr = process
                .search_address(DISPATCHER_SIG)
                .map_err(|e| anyhow!("loadprobe: dispatcher sig failed: {e:?}"))?;

            unsafe {
                let func: DispatcherFunc = std::mem::transmute(addr);
                Dispatcher.initialize(func, run)?;
                Dispatcher.enable()?;
            }

            log::info!("HOOKDIAG loadprobe armed on dispatcher (call the game's stage-load)");
            Ok(())
        }
    }

    fn run(a1: *const usize, a2: u32) -> *const usize {
        // Learn what type-hashes flow through this dispatcher (first N calls).
        if crate::hooks::diag::first_n(&HASH_LOGS, MAX_HASH_LOGS) {
            crate::hooks::diag::ev!("dispatcher_hash", "edx={a2:#x}");
        }
        if a2 == PLAYER_DATA_TYPE_HASH && crate::hooks::diag::first_n(&CAPTURES, MAX_CAPTURES) {
            // Deep walk: player_load may be a few frames above the dispatcher call.
            crate::hooks::diag::log_callers_depth("player_data_lookup", 24);
        }
        unsafe { Dispatcher.call(a1, a2) }
    }
}
