use std::ptr;
use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};

use anyhow::Result;

use crate::hooks::ffi::QuestState;
use crate::process::Process;

pub static QUEST_STATE_PTR: AtomicPtr<QuestState> = AtomicPtr::new(ptr::null_mut());
pub static PLAYER_DATA_OFFSET: AtomicU32 = AtomicU32::new(0);
pub static WEAPON_OFFSET: AtomicU32 = AtomicU32::new(0);
pub static OVERMASTERY_OFFSET: AtomicU32 = AtomicU32::new(0);
pub static SIGIL_OFFSET: AtomicU32 = AtomicU32::new(0);
pub static SBA_OFFSET: AtomicU32 = AtomicU32::new(0);

// player_data — re-derived for v2.0.2. The type-hash constant 0x887ae0b0 survives,
// but the compiler changed `mov eax,K`->`mov r8d,K` (b8 -> 41 b8) and the lea base
// rsi->r14 (48 8d 8e -> 49 8d 8e). Captures 0xa0 from `lea rcx,[r14+0xa0]`.
// One constant, used by BOTH the live resolution and the hookdiag anchor log below —
// if they drift apart the logged RVA no longer describes the scan that fed the offset.
const PLAYER_DATA_SIG: &str =
    "3d b0 e0 7a 88 75 ? 45 31 ff e9 ? ? ? ? 41 b8 b0 e0 7a 88 45 31 ff eb ? 49 8d 8e '";

/// Resolve one offset signature with uniform reporting: console print on success,
/// named warn (+ console FAIL) on failure. Returns `None` on failure so the caller
/// skips the dependent store — the same log-and-continue policy as `try_step` in
/// hooks/mod.rs, so a single stale signature can't take down the others.
fn find_offset<T: Copy + std::fmt::LowerHex>(
    process: &Process,
    name: &str,
    sig: &str,
) -> Option<T> {
    match process.search_slice::<T>(sig) {
        Ok(v) => {
            #[cfg(feature = "console")]
            println!("{name}: {v:x}");
            Some(v)
        }
        Err(e) => {
            log::warn!("Could not find {name}: {e:?}");
            #[cfg(feature = "console")]
            println!("[global FAIL] {name}: {e:?}");
            None
        }
    }
}

pub fn setup_globals(process: &Process) -> Result<()> {
    // Each offset is resolved independently: a game patch (e.g. 2.0.2 Endless
    // Ragnarok) breaks these signatures one at a time, and we don't want a single
    // stale offset to prevent the others (and every downstream hook) from working.
    // Whatever resolves is stored; failures are logged by name for re-derivation.

    // hookdiag: the type-hash match site sits INSIDE the player-loading code path, whose
    // own function signature no longer matches post-2.0.2. Logging its RVA gives Ghidra's
    // FindEntry a confirmed anchor to recover the enclosing `player_load` function.
    #[cfg(feature = "hookdiag")]
    if let Ok(rva) = process.search_match_rva(PLAYER_DATA_SIG) {
        log::info!(
            "HOOKDIAG player_data type-hash match site rva={rva:#x} (feed to Ghidra FindEntry)"
        );
    }

    let player_data_offset = find_offset::<u32>(process, "player_data_offset", PLAYER_DATA_SIG);
    if let Some(v) = player_data_offset {
        PLAYER_DATA_OFFSET.store(v, Ordering::Relaxed);
    }

    // The sigil/weapon/overmastery offsets are stored relative to player_data, so they
    // can only be computed once player_data is known. TODO(v2.0.2): re-derive these
    // three signatures — they currently do not match the expansion binary.
    if let Some(player_data_offset) = player_data_offset {
        if let Some(v) = find_offset::<u32>(
            process,
            "sigil offset",
            "8b 01 eb 02 31 c0 49 8b 8c 24 ' ? ? ? ? 89 81 ? ? ? ?",
        ) {
            SIGIL_OFFSET.store(player_data_offset + v, Ordering::Relaxed);
        }

        if let Some(v) = find_offset::<u8>(
            process,
            "weapon offset",
            "48 ? ? ' ? 48 ? ? ? 48 ? ? e8 ? ? ? ? 31 ?",
        ) {
            WEAPON_OFFSET.store(player_data_offset + v as u32, Ordering::Relaxed);
        }

        if let Some(v) = find_offset::<u32>(
            process,
            "overmastery offset",
            "49 8D 8C 24 ' ? ? ? ? 48 8D 93 ? ? ? ? E8 ? ? ? ?",
        ) {
            OVERMASTERY_OFFSET.store(player_data_offset + v, Ordering::Relaxed);
        }
    }

    // sba_offset is absolute (not player_data-relative). TODO(v2.0.2): re-derive.
    if let Some(v) = find_offset::<u32>(
        process,
        "sba offset",
        "7E ? C5 FA 59 81 ? ? ? ? 48 81 C1 ' ? ? ? ? C5 F8 54 0D ? ? ? ?",
    ) {
        SBA_OFFSET.store(v, Ordering::Relaxed);
    }

    Ok(())
}
