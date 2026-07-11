//! Runtime-address diagnostics for re-deriving broken FUNCTION hooks after a game
//! patch (feature `hookdiag`, off by default).
//!
//! When a patch shifts the caller context around a hook's target function, the static
//! signature stops matching and there is often no unique surviving byte anchor to
//! re-lock onto. This module turns the problem around: from the hooks that STILL work,
//! it logs the game module's base address plus the **return address** (who called this
//! hook) as a module-relative RVA. Triggering the corresponding in-game event then
//! prints the RVA of the calling function, which sits right next to the broken target —
//! turning a blind static search into a single confirmed address.
//!
//! Everything here compiles to nothing unless `--features hookdiag` is set.

use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(feature = "hookdiag")]
use std::sync::atomic::AtomicUsize;
#[cfg(feature = "hookdiag")]
use std::sync::OnceLock;
#[cfg(feature = "hookdiag")]
use std::time::Instant;

/// True only for the first `n` calls counted by `counter` — the shared guard for
/// "log only the first N occurrences" diagnostics (rate-limits log spam from hooks
/// that fire constantly). Compiled in all builds: `dmgdiag` uses it without `hookdiag`.
#[allow(dead_code)] // unused in builds with no diagnostic feature enabled
pub fn first_n(counter: &AtomicU32, n: u32) -> bool {
    counter.fetch_add(1, Ordering::Relaxed) < n
}

/// Log a labelled event with a timestamp and a formatted value string:
/// `diag::ev!("sba_attempt", "a2={a2}")`. A macro (not a fn) so the `format!`
/// arguments are never evaluated unless `hookdiag` is enabled — a no-op fn shim
/// would still make every release build allocate the argument string.
macro_rules! ev {
    ($label:expr, $($arg:tt)+) => {{
        #[cfg(feature = "hookdiag")]
        $crate::hooks::diag::ev_str($label, &format!($($arg)+));
    }};
}
pub(crate) use ev;

/// The game module base, captured once at hook setup, so logged absolute addresses can
/// be converted to RVAs (subtract this) for use with the sigscan/Ghidra tooling.
#[cfg(feature = "hookdiag")]
pub static MODULE_BASE: AtomicUsize = AtomicUsize::new(0);

/// Monotonic start instant, so every diagnostic line carries an elapsed-milliseconds
/// timestamp. Frequency + timing of events (e.g. a rising SBA gauge vs. a one-shot
/// death) is how we identify which broken handler is which from the log alone.
#[cfg(feature = "hookdiag")]
static START: OnceLock<Instant> = OnceLock::new();

#[cfg(feature = "hookdiag")]
fn ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

#[cfg(feature = "hookdiag")]
pub fn set_module_base(base: usize) {
    MODULE_BASE.store(base, Ordering::Relaxed);
    START.get_or_init(Instant::now);
    log::info!("HOOKDIAG t=0 module_base={:#x}", base);
}

/// Log a labelled event with a timestamp and a free-form value string. This is the
/// primary signal for the behavioural-identification approach: the label groups events,
/// `t` gives frequency/timing, and `vals` carries argument values (e.g. a climbing SBA
/// gauge) so each event's fingerprint is visible in the log. Call via the `ev!` macro,
/// which skips argument construction entirely when `hookdiag` is off.
#[cfg(feature = "hookdiag")]
pub fn ev_str(label: &str, vals: &str) {
    log::info!("HOOKDIAG t={} ev={label} {vals}", ms());
}

/// Log a labelled runtime address as an RVA (address - module_base). Use for pointers a
/// working hook receives (entity, sba object) so their layout/callsite can be inspected.
#[cfg(feature = "hookdiag")]
#[allow(dead_code)] // kept as a ready diagnostic helper for the next re-derivation
pub fn log_addr(label: &str, addr: usize) {
    let base = MODULE_BASE.load(Ordering::Relaxed);
    if base != 0 && addr > base {
        log::info!("HOOKDIAG t={} {label} abs={:#x} rva={:#x}", ms(), addr, addr - base);
    } else {
        log::info!("HOOKDIAG t={} {label} abs={:#x} (rva n/a)", ms(), addr);
    }
}

/// Walk the return-address stack and log every address that lies inside the game module,
/// as RVAs, at the point a still-working hook fires. The frames just above the hook are
/// the game functions that drive this event (e.g. the SBA manager that calls sba_attempt)
/// — adjacent in the binary to the OTHER broken handlers, and often the exact caller we
/// need. `backtrace` reads real unwind info, so this is robust under optimization (no
/// fragile [rbp+8] assumptions).
#[cfg(feature = "hookdiag")]
pub fn log_callers(label: &str) {
    log_callers_depth(label, 12);
}

/// Like `log_callers` but with an explicit max frame count. A deeper walk (e.g. 24) at a
/// hook that fires once per encounter captures the whole subsystem call chain, so nearby
/// broken handlers (e.g. player_load, whose own caller context is gone) can be located by
/// inspecting the reported RVAs in Ghidra.
#[cfg(feature = "hookdiag")]
pub fn log_callers_depth(label: &str, max: usize) {
    let base = MODULE_BASE.load(Ordering::Relaxed);
    // Only report addresses within ~256 MB above base (exe is ~123 MB) to skip system DLLs.
    let span = 0x1000_0000usize;
    let mut frames: Vec<String> = Vec::new();
    backtrace::trace(|frame| {
        let ip = frame.ip() as usize;
        if base != 0 && ip > base && ip - base < span {
            frames.push(format!("{:#x}", ip - base));
        }
        frames.len() < max
    });
    log::info!("HOOKDIAG t={} callers[{label}] rvas: {}", ms(), frames.join(" "));
}

/// Returns true only if `[addr, addr+len)` is committed, readable memory (guards every deref
/// so the probe can NEVER fault the game). Uses VirtualQuery — a bad "plausible pointer" that
/// points at unmapped/guard memory is rejected before we touch it.
#[cfg(feature = "hookdiag")]
fn readable(addr: usize, len: usize) -> bool {
    use windows::Win32::System::Memory::{
        VirtualQuery, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS,
    };
    if addr == 0 {
        return false;
    }
    let mut mbi = MEMORY_BASIC_INFORMATION::default();
    let got = unsafe {
        VirtualQuery(
            Some(addr as *const _),
            &mut mbi,
            std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
        )
    };
    if got == 0 || mbi.State != MEM_COMMIT {
        return false;
    }
    // Reject no-access / guard pages.
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)).0 != 0 {
        return false;
    }
    // Ensure the whole [addr, addr+len) span stays within this committed region.
    let region_end = mbi.BaseAddress as usize + mbi.RegionSize;
    addr + len <= region_end
}

/// Scan a player-instance pointer for the display/character name and party data that
/// `player_load` used to publish. `player_load` reached these via a pointer field to a
/// SigilList (name at +0x1E8/+0x208, party_index at +0x22C, is_online at +0x1C8), so we:
///   1. log printable ASCII runs found DIRECTLY in the instance (window 0..0x400), and
///   2. for each pointer-sized field in that window, deref it and log any ASCII behind it,
///      tagged with the field offset — this reveals the SigilList pointer offset by showing
///      the name text behind it.
/// Rate-limited to a handful of distinct instances (party members) so the log stays readable.
/// This is a READ-ONLY hunt: seeing your actual character name as text pins the offsets with
/// certainty, no guessing. EVERY read is VirtualQuery-guarded so it cannot fault the game.
#[cfg(feature = "hookdiag")]
pub fn probe_player_instance(instance: usize) {
    use std::sync::Mutex;
    // Dedupe by instance address so we dump each DISTINCT party member/pet once, instead of
    // burning the budget on repeated hits from the same attacker.
    static SEEN: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    const MAX: usize = 8;
    if instance == 0 {
        return;
    }
    {
        let mut seen = SEEN.lock().unwrap();
        if seen.contains(&instance) || seen.len() >= MAX {
            return;
        }
        seen.push(instance);
    }

    // Bail immediately if the instance itself isn't fully readable.
    if !readable(instance, 0x400) {
        log::info!("HOOKDIAG probe instance={instance:#x} NOT READABLE (skipped)");
        return;
    }

    let base = instance as *const u8;

    // A "name-like" run: letters/digits/space/a few punct, length 2..=15. Rejects the float
    // noise (e.g. ']dmA','v:SA') that a raw printable-ASCII test lets through. Reads are guarded.
    // Tries BOTH 8-bit (ASCII, contiguous bytes) and 16-bit (UTF-16LE, name\0-interleaved)
    // since GBFR display names can be either.
    let name_at = |p: *const u8| -> Option<String> {
        if !readable(p as usize, 40) {
            return None;
        }
        let is_name_char =
            |c: char| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-' || c == '.';
        // 8-bit attempt.
        let mut a = String::new();
        for i in 0..20usize {
            let b = unsafe { p.add(i).read() };
            if b == 0 {
                break;
            }
            let c = b as char;
            if !is_name_char(c) {
                a.clear();
                break;
            }
            a.push(c);
        }
        if (2..=15).contains(&a.len()) && a.chars().any(|c| c.is_ascii_alphabetic()) {
            return Some(format!("ascii:'{a}'"));
        }
        // UTF-16LE attempt.
        let mut w = String::new();
        for i in 0..20usize {
            let lo = unsafe { p.add(i * 2).read() };
            let hi = unsafe { p.add(i * 2 + 1).read() };
            if lo == 0 && hi == 0 {
                break;
            }
            if hi != 0 {
                w.clear();
                break;
            }
            let c = lo as char;
            if !is_name_char(c) {
                w.clear();
                break;
            }
            w.push(c);
        }
        if (2..=15).contains(&w.len()) && w.chars().any(|c| c.is_ascii_alphabetic()) {
            return Some(format!("utf16:'{w}'"));
        }
        None
    };

    // 1. Names DIRECTLY in the instance (wide window — SigilList data may be inlined far out).
    let mut direct = String::new();
    for off in (0..0x1000usize).step_by(2) {
        if let Some(s) = name_at(unsafe { base.add(off) }) {
            direct.push_str(&format!("[+{off:#x}]={s} "));
        }
    }
    log::info!(
        "HOOKDIAG probe instance={instance:#x} direct_names: {}",
        if direct.is_empty() { "(none)".into() } else { direct }
    );

    // 2. Names behind pointer fields — the SigilList is reached via a pointer in the instance.
    // For each pointer field in a wide window, scan a wide range behind it for a name.
    let mut behind = String::new();
    for off in (0..0x800usize).step_by(8) {
        if !readable(base as usize + off, 8) {
            continue;
        }
        let field = unsafe { (base.add(off) as *const usize).read() };
        if field > 0x10000 && field < 0x0000_7fff_ffff_ffff && field % 4 == 0 {
            let p = field as *const u8;
            for probe in (0..0x300usize).step_by(2) {
                if let Some(s) = name_at(unsafe { p.add(probe) }) {
                    behind.push_str(&format!("[+{off:#x}]->+{probe:#x}={s} "));
                }
            }
        }
    }
    log::info!(
        "HOOKDIAG probe instance={instance:#x} behind_ptr_names: {}",
        if behind.is_empty() { "(none)".into() } else { behind }
    );
}

// No-op shims so call sites don't need their own cfg guards.
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_player_instance(_instance: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
pub fn set_module_base(_base: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn log_addr(_label: &str, _addr: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
pub fn log_callers(_label: &str) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn log_callers_depth(_label: &str, _max: usize) {}
