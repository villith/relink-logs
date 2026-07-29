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

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

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

/// Per-key variant of `first_n`: true for the first `n` calls per distinct `key`
/// (e.g. per target actor base), so one early actor can't burn the whole probe
/// budget before the interesting one (a boss) ever appears. Tracks at most 64
/// keys; calls with later keys return false. `try_lock` so a hook hot path can
/// never block on (or cascade a poison from) another thread.
#[allow(dead_code)] // unused in builds with no diagnostic feature enabled
pub fn first_n_per_key(map: &std::sync::Mutex<Vec<(usize, u32)>>, key: usize, n: u32) -> bool {
    let Ok(mut entries) = map.try_lock() else {
        return false;
    };
    if let Some(entry) = entries.iter_mut().find(|e| e.0 == key) {
        if entry.1 >= n {
            return false;
        }
        entry.1 += 1;
        true
    } else if entries.len() < 64 {
        entries.push((key, 1));
        true
    } else {
        false
    }
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

/// The game module base, captured once at hook setup. Diagnostics use it to convert
/// logged absolute addresses to RVAs; production readers use it to resolve global
/// singletons as `module_base + RVA` (e.g. the equipped-state save root the weapon
/// identity walk starts from), so it is compiled in ALL builds.
pub static MODULE_BASE: AtomicUsize = AtomicUsize::new(0);

/// Monotonic start instant, so every diagnostic line carries an elapsed-milliseconds
/// timestamp. Frequency + timing of events (e.g. a rising SBA gauge vs. a one-shot
/// death) is how we identify which broken handler is which from the log alone.
#[cfg(feature = "hookdiag")]
static START: OnceLock<Instant> = OnceLock::new();

#[cfg(feature = "hookdiag")]
pub(crate) fn ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

pub fn set_module_base(base: usize) {
    MODULE_BASE.store(base, Ordering::Relaxed);
    #[cfg(feature = "hookdiag")]
    {
        START.get_or_init(Instant::now);
        log::info!("HOOKDIAG t=0 module_base={:#x}", base);
    }
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

/// Returns true only if `[addr, addr+len)` is readable memory (guards every deref so the
/// probe can NEVER fault the game). SEH-probed via `IsBadReadPtr`: kernel32 touches one
/// byte per page in the span and catches any access violation internally, so a bad
/// "plausible pointer" is rejected without an exception ever reaching our frame.
///
/// Deliberately NOT VirtualQuery: VirtualQuery takes the process address-space (VAD)
/// lock, which the game's own allocator hammers while spawning actors. Measured on this
/// machine: ~200 ns/call idle but ~7,900 ns/call under allocation churn, vs a flat ~2 ns
/// for the SEH probe. At ~7 guarded reads per damage event that lock contention was the
/// v1.9.2 in-combat slowdown (worst at combat start / new enemy waves, fading as
/// spawning settles).
///
/// Caveat inherited from `IsBadReadPtr`: probing a PAGE_GUARD page reports "bad" but
/// consumes the page's guard status. Our callers probe heap actor/flow structs, never
/// stack addresses, so this doesn't arise in practice — do not point this at stacks.
///
/// Compiled in all builds: the real Conflux emitters (endless.rs / quest.rs) use
/// `read_u32_guarded` at runtime to read the reception-flow type-hash and buff ids,
/// so this guard must exist without `hookdiag`.
pub(crate) fn readable(addr: usize, len: usize) -> bool {
    // Deprecated-but-ubiquitous kernel32 export; not exposed by the `windows` crate.
    #[link(name = "kernel32")]
    extern "system" {
        fn IsBadReadPtr(lp: *const std::ffi::c_void, ucb: usize) -> i32;
    }
    // Reject null and any addr+len that would wrap past the top of the address space
    // (upholds the "can NEVER fault" contract for arbitrary inputs, not just the
    // pre-filtered pointers today's callers pass).
    if addr == 0 || addr.checked_add(len).is_none() {
        return false;
    }
    unsafe { IsBadReadPtr(addr as *const _, len) == 0 }
}

/// Read a single `u32` at `base + offset`, returning 0 if `base` is null or the location
/// isn't committed/readable. VirtualQuery-guarded, so it can NEVER fault the game — safe to
/// point at a possibly-stale pointer (e.g. the reception-flow slot, which may be null between
/// runs). Used by the EndlessMode reception hook to read a flow object's type-hash stamp.
pub fn read_u32_guarded(base: usize, offset: usize) -> u32 {
    if base == 0 {
        return 0;
    }
    let addr = base.wrapping_add(offset);
    if !readable(addr, 4) {
        return 0;
    }
    unsafe { (addr as *const u32).read_unaligned() }
}

/// Read a pointer-sized value at `base + offset`, returning `None` if `base` is null or the
/// location isn't committed/readable. VirtualQuery-guarded — can NEVER fault the game.
///
/// Unlike [`read_u32_guarded`] this distinguishes "unreadable" (`None`) from a legitimately
/// zero value (`Some(0)`), which the damage hook needs so it can BAIL on an unfamiliar actor
/// layout rather than proceeding with a bogus 0 pointer. A new character can be a `Pl####`
/// class with a different instance size, so an offset valid for known actors may fall outside
/// its allocation — that returns `None` here instead of hard-faulting the game thread.
pub fn read_ptr_guarded(base: usize, offset: usize) -> Option<usize> {
    if base == 0 {
        return None;
    }
    let addr = base.wrapping_add(offset);
    if !readable(addr, std::mem::size_of::<usize>()) {
        return None;
    }
    Some(unsafe { (addr as *const usize).read_unaligned() })
}

/// Read a `u64` at `base + offset`, returning `None` if `base` is null or the location isn't
/// committed/readable. VirtualQuery-guarded — can NEVER fault the game. Distinct from
/// [`read_ptr_guarded`] only in intent: this is for values that happen to be 64-bit (scene-map
/// uuids, hash-table masks) rather than for pointers to follow.
///
/// Part of the reader family rather than the diag probes, but every caller today is
/// hookdiag-gated — so it reads as dead in a plain build.
#[allow(dead_code)]
pub fn read_u64_guarded(base: usize, offset: usize) -> Option<u64> {
    if base == 0 {
        return None;
    }
    let addr = base.wrapping_add(offset);
    if !readable(addr, 8) {
        return None;
    }
    Some(unsafe { (addr as *const u64).read_unaligned() })
}

/// Read `len` raw bytes at `base + offset`, returning `None` if `base` is null or any part
/// of the range isn't committed/readable. Guarded like the other readers — can NEVER fault
/// the game. Used by the weapon-identity walk to read the equipped-weapon id, which the
/// save stores as inline ASCII rather than a hash.
pub fn read_bytes_guarded(base: usize, offset: usize, len: usize) -> Option<Vec<u8>> {
    if base == 0 || len == 0 {
        return None;
    }
    let addr = base.wrapping_add(offset);
    if !readable(addr, len) {
        return None;
    }
    let mut out = vec![0u8; len];
    unsafe { std::ptr::copy_nonoverlapping(addr as *const u8, out.as_mut_ptr(), len) };
    Some(out)
}

/// Read an `f32` at `base + offset`, returning `None` if `base` is null or the location isn't
/// committed/readable. VirtualQuery-guarded — can NEVER fault the game. Used for the damage
/// hook's stun-value read on the (possibly unfamiliar) target actor.
pub fn read_f32_guarded(base: usize, offset: usize) -> Option<f32> {
    if base == 0 {
        return None;
    }
    let addr = base.wrapping_add(offset);
    if !readable(addr, 4) {
        return None;
    }
    Some(unsafe { (addr as *const f32).read_unaligned() })
}

/// Dump every nonzero `u32` in the window `[base, base+len)` as `+off=val` (hex offset,
/// decimal value), for re-deriving struct field offsets from a live playthrough. Used for
/// the Conflux/EndlessMode work (see hooks/endless.rs, quest.rs): walking room→room, the
/// field that increments is the room/run counter; the buff component's populated slots are
/// the picked abilities. Which offset means what is decoded from how the value CHANGES
/// across the log, so we dump the raw window and let the playthrough reveal the layout.
///
/// Rate-limited to a handful of DISTINCT base addresses so the log stays readable when a
/// hook fires repeatedly on the same object. EVERY read is VirtualQuery-guarded (per 4-byte
/// slot) so it can NEVER fault the game, even if `base`/`len` describe unmapped memory.
///
/// The one-shot counterpart of [`probe_u32_window_delta`]: use this when you want ONE full
/// snapshot per distinct object (a freshly-created struct whose layout you're mapping), and
/// the delta variant when the same object mutates over time and you want the changes. Kept
/// as a ready helper even when call sites currently prefer the delta form.
#[cfg(feature = "hookdiag")]
#[allow(dead_code)]
pub fn probe_u32_window(label: &str, base: usize, len: usize) {
    use std::sync::Mutex;
    // Dedup by base so repeated hits on the same instance don't re-dump; cap total distinct
    // dumps so an unbounded stream of new instances can't flood the log.
    static SEEN: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    const MAX_DISTINCT: usize = 64;
    if base == 0 {
        return;
    }
    {
        let mut seen = SEEN.lock().unwrap();
        if seen.contains(&base) {
            return;
        }
        if seen.len() >= MAX_DISTINCT {
            return;
        }
        seen.push(base);
    }

    let mut out = String::new();
    let mut off = 0usize;
    while off + 4 <= len {
        let addr = base + off;
        if readable(addr, 4) {
            let v = unsafe { (addr as *const u32).read_unaligned() };
            if v != 0 {
                out.push_str(&format!("+{off:#x}={v} "));
            }
        }
        off += 4;
    }
    log::info!(
        "HOOKDIAG t={} probe[{label}] base={base:#x} len={len:#x} u32s: {}",
        ms(),
        if out.is_empty() { "(all zero/unreadable)".into() } else { out }
    );
}

/// One hit: a needle (or generic-shape) match at an offset in the scanned window, or behind
/// a pointer found in it. Carried as data rather than a formatted string so the dedup and
/// the output cap can discard it without ever having allocated one — a noisy page produces
/// tens of thousands of these for a 400-hit budget.
#[cfg(feature = "hookdiag")]
struct NeedleHit<'a> {
    /// Offset of the pointer this hit was found behind, or `None` for an inline hit.
    via: Option<usize>,
    off: usize,
    value: u32,
    name: &'a str,
}

/// Scan a large object for a fixed set of u32 needle values (plus the generic
/// `0x0002xxxx` packed-enemy-id shape) and one level of pointer chasing, logging
/// `+off=value(name)` inline and `+srcOff->blk+off=value(name)` behind a pointer, for every
/// hit not already logged under this label.
///
/// Built for the Conflux boss-source hunt: the 408KB `EndlessModeQuestManager` must hold the
/// drawn boss's identity SOMEWHERE (packed `0x20000|EM`, or the XXHash32 actor-type hash),
/// and a full delta probe of that window would log an unusable first-visit snapshot, so we
/// look only for the known identity encodings. The flat scan found NO identity inline (live
/// capture 2026-07-28, room 847010/Rock Golem), so every plausible heap pointer in the window
/// (aligned u64s in user-space range) also has its first `BLK` bytes scanned.
///
/// Page-wise `readable()` guard; dedup set bounds re-logging; per-call output cap bounds a
/// pathological page. A `scanstats` line makes an empty result diagnosable (scanned-but-empty
/// vs didn't-run). hookdiag-only.
#[cfg(feature = "hookdiag")]
pub fn scan_u32_needles_deep(label: &str, base: usize, len: usize, needles: &[(u32, &str)]) {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    /// `(via, off, value)` — one hit, in the form the dedup keys on.
    type HitKey = (Option<usize>, usize, u32);
    // Keyed by label so the per-hit key costs no allocation: one String per distinct label,
    // not one per hit.
    static SEEN: Mutex<Option<HashMap<String, HashSet<HitKey>>>> = Mutex::new(None);
    const BLK: usize = 0x400;
    const MAX_BLOCKS: usize = 2000;
    if base == 0 {
        return;
    }
    let mut lookup: HashMap<u32, &str> = HashMap::with_capacity(needles.len());
    // Low byte of every needle. The scan below classifies ~614k words against a needle set of
    // a few dozen that almost never matches, so this gates the (SipHash) map probe behind one
    // array index — while still consulting the map FIRST, since a needle may itself have the
    // generic `0x0002xxxx` shape and must keep its own name.
    let mut needle_byte = [false; 256];
    for (v, n) in needles {
        lookup.insert(*v, *n);
        needle_byte[(*v & 0xff) as usize] = true;
    }
    let classify = |v: u32| -> Option<&str> {
        if needle_byte[(v & 0xff) as usize] {
            if let Some(name) = lookup.get(&v) {
                return Some(name);
            }
        }
        // Any 0x0002xxxx word: the packed-enemy-id shape with an id we didn't anticipate.
        // Logged with a generic tag so nothing slips through.
        if (v >> 16) == 2 && (v & 0xffff) != 0 {
            Some("generic2x")
        } else {
            None
        }
    };
    let mut hits: Vec<NeedleHit> = Vec::new();
    let mut inline_hits = 0usize;
    let mut pointers: Vec<(usize, usize)> = Vec::new(); // (src offset, target)
    let mut ptr_seen: HashSet<usize> = HashSet::new();
    let (mut pages, mut pages_ok) = (0u32, 0u32);
    let mut page = 0usize;
    while page < len {
        let chunk = (len - page).min(0x1000);
        let addr = base + page;
        pages += 1;
        if readable(addr, chunk) {
            pages_ok += 1;
            let mut off = 0usize;
            while off + 4 <= chunk {
                let v = unsafe { ((addr + off) as *const u32).read_unaligned() };
                if let Some(name) = classify(v) {
                    hits.push(NeedleHit { via: None, off: page + off, value: v, name });
                    inline_hits += 1;
                }
                // Aligned u64 = pointer candidate (user-space heap range, 8-aligned target).
                if (page + off) % 8 == 0 && off + 8 <= chunk {
                    let p = unsafe { ((addr + off) as *const u64).read_unaligned() } as usize;
                    if p >= 0x10000
                        && p < 0x0000_8000_0000_0000
                        && p % 8 == 0
                        && pointers.len() < MAX_BLOCKS
                        && ptr_seen.insert(p)
                    {
                        pointers.push((page + off, p));
                    }
                }
                off += 4;
            }
        }
        page += 0x1000;
    }
    let mut blocks_ok = 0u32;
    for (src, p) in &pointers {
        if !readable(*p, BLK) {
            continue;
        }
        blocks_ok += 1;
        let mut off = 0usize;
        while off + 4 <= BLK {
            let v = unsafe { ((*p + off) as *const u32).read_unaligned() };
            if let Some(name) = classify(v) {
                hits.push(NeedleHit { via: Some(*src), off, value: v, name });
            }
            off += 4;
        }
    }
    ev_str(
        "scanstats",
        &format!(
            "label={label} base={base:#x} pages={pages} readable={pages_ok} ptrs={} blocks_ok={blocks_ok} inline_hits={inline_hits} blk_hits={}",
            pointers.len(),
            hits.len() - inline_hits
        ),
    );
    let mut guard = SEEN.lock().unwrap();
    let seen = guard
        .get_or_insert_with(HashMap::new)
        .entry(label.to_string())
        .or_default();
    let mut out = String::new();
    let mut n = 0;
    for hit in hits {
        if !seen.insert((hit.via, hit.off, hit.value)) {
            continue;
        }
        match hit.via {
            Some(src) => out.push_str(&format!(
                "+{src:#x}->blk+{:#x}={:#x}({}) ",
                hit.off, hit.value, hit.name
            )),
            None => out.push_str(&format!("+{:#x}={:#x}({}) ", hit.off, hit.value, hit.name)),
        }
        n += 1;
        if n >= 400 {
            out.push_str("...cap");
            break;
        }
    }
    if !out.is_empty() {
        ev_str("needlescan", &format!("label={label} base={base:#x} {out}"));
    }
}

/// Like `probe_u32_window`, but re-dumps the SAME object across repeated hits, logging only
/// the offsets whose value CHANGED since the previous visit (`+off:old->new`). This is what
/// `probe_u32_window` (dedup-by-address, one-shot) cannot do: on a long-lived object — e.g.
/// the EndlessModeQuestManager or the stage-quest manager that `on_load_quest_state` receives
/// every room — the room/run counter is a field that INCREMENTS in place, so the signal is
/// the delta, not the absolute snapshot. First visit logs the full nonzero snapshot (tagged
/// `first`); later visits log only diffs (tagged `delta`). Snapshots are keyed by (label,base)
/// so different probe sites don't clobber each other; capped so an unbounded stream of new
/// bases can't grow memory without bound. Every read is VirtualQuery-guarded (can't fault).
#[cfg(feature = "hookdiag")]
pub fn probe_u32_window_delta(label: &str, base: usize, len: usize) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    // (label,base) -> last-seen offset->value map. Only nonzero (or previously-seen) offsets
    // are tracked, matching the snapshot format.
    static SNAPS: Mutex<Option<HashMap<(String, usize), HashMap<usize, u32>>>> = Mutex::new(None);
    const MAX_KEYS: usize = 128;
    if base == 0 {
        return;
    }

    // Read the current window into a fresh map (guarded per slot).
    let mut cur: std::collections::HashMap<usize, u32> = std::collections::HashMap::new();
    let mut off = 0usize;
    while off + 4 <= len {
        let addr = base + off;
        if readable(addr, 4) {
            let v = unsafe { (addr as *const u32).read_unaligned() };
            if v != 0 {
                cur.insert(off, v);
            }
        }
        off += 4;
    }

    let mut guard = SNAPS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let key = (label.to_string(), base);

    match map.get(&key) {
        None => {
            if map.len() >= MAX_KEYS {
                return;
            }
            // First visit: full snapshot.
            let mut out = String::new();
            let mut offs: Vec<usize> = cur.keys().copied().collect();
            offs.sort_unstable();
            for o in offs {
                out.push_str(&format!("+{o:#x}={} ", cur[&o]));
            }
            log::info!(
                "HOOKDIAG t={} probe_delta[{label}] base={base:#x} first: {}",
                ms(),
                if out.is_empty() { "(all zero/unreadable)".into() } else { out }
            );
            map.insert(key, cur);
        }
        Some(prev) => {
            // Later visit: log only changed offsets (including new nonzero and cleared-to-zero).
            let mut out = String::new();
            let mut changed: Vec<usize> = Vec::new();
            for (&o, &v) in cur.iter() {
                if prev.get(&o) != Some(&v) {
                    changed.push(o);
                }
            }
            // Offsets that were nonzero before and are now zero/gone.
            for &o in prev.keys() {
                if !cur.contains_key(&o) {
                    changed.push(o);
                }
            }
            changed.sort_unstable();
            changed.dedup();
            for o in &changed {
                let old = prev.get(o).copied().unwrap_or(0);
                let new = cur.get(o).copied().unwrap_or(0);
                out.push_str(&format!("+{o:#x}:{old}->{new} "));
            }
            log::info!(
                "HOOKDIAG t={} probe_delta[{label}] base={base:#x} delta: {}",
                ms(),
                if out.is_empty() { "(no change)".into() } else { out }
            );
            map.insert(key, cur);
        }
    }
}

/// Snapshot the f32 window `[base+start, base+start+len)` for [`log_f32_increases`].
/// Unreadable slots become NAN so they can never masquerade as a delta. Guarded —
/// can NEVER fault the game.
///
/// Perf: guard the WHOLE window with ONE VirtualQuery, not one per slot. This runs
/// twice per sampled damage event; per-slot guarding was ~768 VirtualQuery syscalls
/// per hit, which dropped the game to single-digit fps once the per-target budget
/// made sampling sustained through combat (2026-07-15). Only if the single-region
/// check fails (window straddles a region boundary) fall back to per-slot guarding.
#[cfg(feature = "hookdiag")]
pub fn snapshot_f32_window(base: usize, start: usize, len: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(len / 4);
    let win = base.wrapping_add(start);
    if readable(win, len) {
        let mut off = 0usize;
        while off + 4 <= len {
            out.push(unsafe { ((win + off) as *const f32).read_unaligned() });
            off += 4;
        }
        return out;
    }
    let mut off = 0usize;
    while off + 4 <= len {
        let addr = win.wrapping_add(off);
        if readable(addr, 4) {
            out.push(unsafe { (addr as *const f32).read_unaligned() });
        } else {
            out.push(f32::NAN);
        }
        off += 4;
    }
    out
}

/// Log every offset in a pre/post f32 window pair whose value INCREASED across the
/// hooked call — for re-deriving accumulator fields (the v2.0.2 stun gauge: the old
/// read at target+0xA70 deltas 0.0 on every hit, so the field moved). The true stun
/// field is the one whose increase correlates with hits landing; decoded offline from
/// the log. Output capped so a churning instance can't flood a line.
#[cfg(feature = "hookdiag")]
pub fn log_f32_increases(label: &str, base: usize, start: usize, pre: &[f32], post: &[f32]) {
    // A gauge-like accumulator lives in a small range; pointer/counter bits
    // reinterpreted as f32 produce e26+ garbage that only spams the log.
    const PLAUSIBLE_MAX: f32 = 1.0e7;
    let mut out = String::new();
    let mut shown = 0usize;
    for (i, (a, b)) in pre.iter().zip(post.iter()).enumerate() {
        if a.is_finite() && b.is_finite() && *b > *a && *a >= 0.0 && *b < PLAUSIBLE_MAX {
            out.push_str(&format!("+{:#x}:{a:.2}->{b:.2} ", start + i * 4));
            shown += 1;
            if shown >= 48 {
                out.push_str("(capped)");
                break;
            }
        }
    }
    // Hits with nothing plausible to report log NOTHING: this fires per sampled
    // damage event, and a synchronous "(no increases)" line per hit is pure cost.
    if !out.is_empty() {
        log::info!("HOOKDIAG t={} f32_up[{label}] base={base:#x} {}", ms(), out);
    }
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
    // Dedup this address (so repeated hits from the same attacker don't re-log), but do NOT
    // consume a budget slot yet — the MAX budget is for successfully-dumped party members, and
    // an unreadable "plausible pointer" must not exhaust it and starve real instances.
    {
        let mut seen = SEEN.lock().unwrap();
        if seen.contains(&instance) {
            return;
        }
        seen.push(instance);
    }

    // Bail immediately if the instance itself isn't fully readable (does not count toward MAX).
    if !readable(instance, 0x400) {
        log::info!("HOOKDIAG probe instance={instance:#x} NOT READABLE (skipped)");
        return;
    }

    // Enforce the dump budget only for readable instances we're actually about to probe.
    {
        static DUMPED: Mutex<usize> = Mutex::new(0);
        let mut dumped = DUMPED.lock().unwrap();
        if *dumped >= MAX {
            return;
        }
        *dumped += 1;
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

/// Remember a confirmed PLAYER combat-instance address (a source the identity path
/// resolved). [`probe_pl2000_parent`] searches a dragon-form instance for pointers back
/// to one of these to re-derive the Pl2000→Pl1900 parent-link offset on v2.0.2.
#[cfg(feature = "hookdiag")]
pub fn note_player_instance(instance: usize) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static KNOWN: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    let known = KNOWN.get_or_init(|| Mutex::new(HashSet::new()));
    let mut known = known.lock().expect("player instance set lock poisoned");
    if known.len() < 128 && known.insert(instance) {
        log::info!("IDDIAG player instance noted: {instance:#x} ({} known)", known.len());
        // Publish an updated snapshot for the probe (rebuilt only when the set grows,
        // so the per-damage-event fast path is one lock + one HashSet probe).
        let snapshot: Vec<usize> = known.iter().copied().collect();
        *PLAYER_INSTANCES_SNAPSHOT
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .expect("player instance snapshot lock poisoned") = snapshot;
    }
}

#[cfg(feature = "hookdiag")]
static PLAYER_INSTANCES_SNAPSHOT: std::sync::OnceLock<std::sync::Mutex<Vec<usize>>> =
    std::sync::OnceLock::new();

/// ONE-SHOT per distinct Pl2000 (Id dragon-form) instance: scan its first 0xE000 bytes
/// for a pointer that leads back to a known player instance, either directly or via the
/// entity indirection (`*(candidate + 0x70)` — the m_pSpecifiedInstance hop the other
/// parent links use). Purely guarded READS (VirtualQuery per access, no vtable calls),
/// so it can never fault; runs once per actor address so it can't lag repeated hits.
///
/// Why: the old parent offset 0xD488 is stale on v2.0.2, which splits Id's dragon-form
/// damage into its own party row. A `hit` line here is the new offset.
#[cfg(feature = "hookdiag")]
pub fn probe_pl2000_parent(instance: usize) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    {
        let seen = SEEN.get_or_init(|| Mutex::new(HashSet::new()));
        let mut seen = seen.lock().expect("pl2000 probe seen lock poisoned");
        if seen.len() >= 16 || !seen.insert(instance) {
            return;
        }
    }

    let known: Vec<usize> = PLAYER_INSTANCES_SNAPSHOT
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("player instance snapshot lock poisoned")
        .clone();

    // Old-offset check first so the log always answers "is 0xD488 still right?".
    let old_entity = read_ptr_guarded(instance, 0xD488);
    let old_inst = old_entity.and_then(|p| read_ptr_guarded(p, 0x70));

    let mut hits = String::new();
    for off in (0usize..0xE000).step_by(8) {
        let Some(p) = read_ptr_guarded(instance, off) else {
            continue;
        };
        if p == 0 {
            continue;
        }
        if known.contains(&p) {
            hits.push_str(&format!("+{off:#x}=direct({p:#x}) "));
            continue;
        }
        if let Some(behind) = read_ptr_guarded(p, 0x70) {
            if known.contains(&behind) {
                hits.push_str(&format!("+{off:#x}=entity->{behind:#x} "));
            }
        }
    }
    log::info!(
        "IDDIAG pl2000 parent scan instance={instance:#x} known_players={} old@0xD488={old_entity:?}->{old_inst:?} hits: {}",
        known.len(),
        if hits.is_empty() { "(none)".into() } else { hits }
    );
}

/// ONE-SHOT per distinct UNMAPPED damage-source actor TYPE: a source that neither
/// `get_source_parent` maps nor resolves as a player via its embedded record — exactly
/// the event class the parser silently drops (`should_ignore_damage_event` discards
/// unknown parent hashes BEFORE the raw event log, so old logs hold no trace of these).
///
/// Same technique as [`probe_pl2000_parent`]: scan the instance's first 0xE000 bytes
/// for a pointer back to a known player instance, direct or via the entity indirection
/// (`*(candidate + 0x70)`). A `hits` offset is the parent-link offset a new
/// `get_source_parent` arm needs. Purely guarded reads, no vtable calls, one scan per
/// distinct type — can't fault and can't lag repeated hits. Enemy sources also land
/// here (they scan once each, hitting nothing) — their type hashes name themselves
/// offline via `scripts/gbfr_hash.py` against the game filelist.
///
/// Why (2026-07-20): Cagliostro's Pain Train / Alexandria summon actors (likely the
/// Wp1892..Wp1898 family; Wp1890, her sled, is the one already mapped) have no parent
/// mapping, so both skills are invisible in the meter.
#[cfg(feature = "hookdiag")]
pub fn probe_unmapped_source_parent(instance: usize, type_id: u32) {
    use std::sync::{Mutex, OnceLock};
    // Per-type scan state: (type, found). NO budgets by request (2026-07-20): a found
    // parent ends that type's scanning (nothing more to learn); until then every hit
    // of the type rescans. Enemy sources rescan on every incoming hit too — if combat
    // slows down under this probe, that cost is why.
    static SCANS: OnceLock<Mutex<Vec<(u32, bool)>>> = OnceLock::new();
    {
        let scans = SCANS.get_or_init(|| Mutex::new(Vec::new()));
        let Ok(mut scans) = scans.try_lock() else {
            return;
        };
        match scans.iter_mut().find(|(t, _)| *t == type_id) {
            Some((_, found)) => {
                if *found {
                    return;
                }
            }
            None => {
                scans.push((type_id, false));
            }
        }
    }

    let known: Vec<usize> = PLAYER_INSTANCES_SNAPSHOT
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("player instance snapshot lock poisoned")
        .clone();

    // A candidate is a player instance if it was noted by the identity path OR its
    // embedded record resolves (pure guarded reads, no vtable calls) — the latter
    // needs no prior identity event, so the scan works even when the summon's hits
    // are the only damage all quest (exactly the Pain Train/Alexandria repro).
    let classify = |candidate: usize| -> Option<&'static str> {
        if known.contains(&candidate) {
            Some("noted")
        } else if crate::hooks::player::player_slot_key_for_actor(candidate as *const usize)
            .is_some()
        {
            Some("record")
        } else {
            None
        }
    };

    let mut found_any = false;
    let mut hits = String::new();
    for off in (0usize..0xE000).step_by(8) {
        let Some(p) = read_ptr_guarded(instance, off) else {
            continue;
        };
        if p == 0 {
            continue;
        }
        if let Some(kind) = classify(p) {
            hits.push_str(&format!("+{off:#x}=direct-{kind}({p:#x}) "));
            found_any = true;
            continue;
        }
        if let Some(behind) = read_ptr_guarded(p, 0x70) {
            if behind != 0 && behind != p {
                if let Some(kind) = classify(behind) {
                    hits.push_str(&format!("+{off:#x}=entity->{kind}({behind:#x}) "));
                    found_any = true;
                }
            }
        }
    }

    if found_any {
        let scans = SCANS.get_or_init(|| Mutex::new(Vec::new()));
        if let Ok(mut scans) = scans.try_lock() {
            if let Some((_, found)) = scans.iter_mut().find(|(t, _)| *t == type_id) {
                *found = true;
            }
        }
    }

    log::info!(
        "UNSRC parent scan type={type_id:#010x} instance={instance:#x} known_players={} hits: {}",
        known.len(),
        if hits.is_empty() { "(none)".into() } else { hits }
    );
}

/// Offsets of the two data blobs the summon body copies out of its `SummonData`
/// record at spawn, read off the game's own reflection tables (the
/// `createAttr` builders name every field and its offset within the blob):
///
/// | body offset | blob | field |
/// |---|---|---|
/// | `0x1010` | `SummonObjectData` | vtable |
/// | `0x1020` | `SummonObjectData` | `id_` (int) |
/// | `0x1024` | `SummonObjectData` | `createFlag_` |
/// | `0x1134` | `SummonObjectData` | `attackName_` |
/// | `0x1138` | `SummonObjectData` | `spAttackName_` |
/// | `0x11B0` | `SummonUnitData` | vtable |
/// | `0x11C0` | `SummonUnitData` | `id_` (int, `-1` until filled) |
/// | `0x1200` | `SummonUnitData` | `fsmName_` (`std::string`) |
/// | `0x1220` | `SummonUnitData` | `type_` (int) |
///
/// The whole body allocation is `0x1C10` bytes (from its factory), so every
/// offset here is comfortably inside it.
#[cfg(feature = "hookdiag")]
mod summon_body {
    pub const OBJECT_DATA_ID: usize = 0x1020;
    pub const OBJECT_DATA_CREATE_FLAG: usize = 0x1024;
    pub const OBJECT_DATA_ATTACK_NAME: usize = 0x1134;
    pub const OBJECT_DATA_SP_ATTACK_NAME: usize = 0x1138;
    pub const UNIT_DATA_ID: usize = 0x11C0;
    pub const UNIT_DATA_FSM_NAME: usize = 0x1200;
    pub const UNIT_DATA_TYPE: usize = 0x1220;
    /// Allocation size of the body object.
    pub const SIZE: usize = 0x1C10;
}

/// Reads an MSVC `std::string` laid out at `base + offset`: 16 bytes that are
/// either the inline buffer or a heap pointer, then size, then capacity. A
/// capacity above 15 means the text lives behind the pointer. Every read is
/// guarded, so a stale offset yields `None` rather than faulting.
#[cfg(feature = "hookdiag")]
fn read_msvc_string(base: usize, offset: usize) -> Option<String> {
    let size = read_ptr_guarded(base, offset + 0x10)?;
    let capacity = read_ptr_guarded(base, offset + 0x18)?;
    // A sane string is short and its capacity is at least its size; anything
    // else means the offset is wrong and we should not chase the pointer.
    if size > capacity || capacity > 0x1000 {
        return None;
    }
    let bytes = if capacity > 15 {
        let heap = read_ptr_guarded(base, offset)?;
        read_bytes_guarded(heap, 0, size)?
    } else {
        read_bytes_guarded(base, offset, size)?
    };
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Dumps the per-summon configuration a generic summon body carries, so two
/// summons that share a body class can be told apart.
///
/// Sixteen summons own a body class and are named from that class hash alone;
/// the rest share generic bodies (`BehaviorSummonObjectBase`, the slime family
/// body) and collapse into one row each. This prints the named fields those
/// bodies copy out of their own `SummonData` record — whichever differs between
/// two summons sharing a body IS the identity we can publish.
///
/// Dumped once per DISTINCT body instance, not once per hit: a summon lands
/// many hits a second, and a full-object guarded scan per hit is the wide
/// instance scan that already had to be pulled from the damage path for
/// stalling the game thread. One dump per spawn loses nothing — these fields
/// are written at spawn and never change. There is no cap on how many distinct
/// bodies dump.
#[cfg(feature = "hookdiag")]
pub fn probe_summon_body(instance: usize, type_id: u32) {
    use std::sync::Mutex;
    static SEEN: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    if instance == 0 {
        return;
    }
    {
        let Ok(mut seen) = SEEN.try_lock() else {
            return;
        };
        if seen.contains(&instance) {
            return;
        }
        seen.push(instance);
    }

    let named = format!(
        "objdata.id_={} objdata.createFlag_={} objdata.attackName_={} \
         objdata.spAttackName_={} unit.id_={} unit.type_={} unit.fsmName_={:?}",
        read_u32_guarded(instance, summon_body::OBJECT_DATA_ID) as i32,
        read_u32_guarded(instance, summon_body::OBJECT_DATA_CREATE_FLAG),
        read_u32_guarded(instance, summon_body::OBJECT_DATA_ATTACK_NAME),
        read_u32_guarded(instance, summon_body::OBJECT_DATA_SP_ATTACK_NAME),
        read_u32_guarded(instance, summon_body::UNIT_DATA_ID) as i32,
        read_u32_guarded(instance, summon_body::UNIT_DATA_TYPE) as i32,
        read_msvc_string(instance, summon_body::UNIT_DATA_FSM_NAME),
    );

    // The whole object too: if the body stores its CONCRETE class hash anywhere
    // (which is what we would rather publish than an opaque index), it shows up
    // here as a u32 matching XXHash32Custom("So####").
    let mut window = String::new();
    let mut off = 0usize;
    while off + 4 <= summon_body::SIZE {
        let addr = instance + off;
        if readable(addr, 4) {
            let v = unsafe { (addr as *const u32).read_unaligned() };
            if v != 0 {
                window.push_str(&format!("+{off:#x}={v:#010x} "));
            }
        }
        off += 4;
    }

    log::info!(
        "SMNBODY t={} type={type_id:#010x} instance={instance:#x} {named}",
        ms()
    );
    log::info!("SMNBODY t={} instance={instance:#x} u32s: {window}", ms());
}

#[cfg(all(test, feature = "hookdiag"))]
mod summon_string_tests {
    use super::read_msvc_string;

    /// Builds an MSVC `std::string` at the start of a buffer: 16 bytes of
    /// inline buffer or heap pointer, then size, then capacity.
    fn write_string(buf: &mut [u8], text: &[u8], capacity: usize, heap: Option<usize>) {
        match heap {
            Some(ptr) => buf[..8].copy_from_slice(&ptr.to_le_bytes()),
            None => buf[..text.len()].copy_from_slice(text),
        }
        buf[0x10..0x18].copy_from_slice(&text.len().to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&capacity.to_le_bytes());
    }

    #[test]
    fn reads_a_short_string_out_of_the_inline_buffer() {
        let mut buf = vec![0u8; 0x40];
        write_string(&mut buf, b"So2100", 15, None);
        assert_eq!(
            read_msvc_string(buf.as_ptr() as usize, 0),
            Some("So2100".into())
        );
    }

    #[test]
    fn follows_the_heap_pointer_once_the_capacity_outgrows_the_buffer() {
        let text = b"SummonFsmWithAVeryLongName".to_vec();
        let mut buf = vec![0u8; 0x40];
        write_string(&mut buf, &text, 31, Some(text.as_ptr() as usize));
        assert_eq!(
            read_msvc_string(buf.as_ptr() as usize, 0),
            Some(String::from_utf8(text).unwrap())
        );
    }

    #[test]
    fn rejects_a_size_larger_than_the_capacity() {
        // A stale offset lands on arbitrary bytes; refusing to chase them is
        // what keeps a wrong offset from being read as a heap pointer.
        let mut buf = vec![0u8; 0x40];
        buf[0x10..0x18].copy_from_slice(&99usize.to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&15usize.to_le_bytes());
        assert_eq!(read_msvc_string(buf.as_ptr() as usize, 0), None);
    }

    #[test]
    fn rejects_an_implausible_capacity() {
        let mut buf = vec![0u8; 0x40];
        buf[0x10..0x18].copy_from_slice(&8usize.to_le_bytes());
        buf[0x18..0x20].copy_from_slice(&usize::MAX.to_le_bytes());
        assert_eq!(read_msvc_string(buf.as_ptr() as usize, 0), None);
    }

    #[test]
    fn unmapped_base_yields_nothing_without_dereferencing() {
        assert_eq!(read_msvc_string(1, 0), None);
    }
}

// No-op shims so call sites don't need their own cfg guards.
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_summon_body(_instance: usize, _type_id: u32) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn note_player_instance(_instance: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_pl2000_parent(_instance: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_player_instance(_instance: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn log_addr(_label: &str, _addr: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_u32_window(_label: &str, _base: usize, _len: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn probe_u32_window_delta(_label: &str, _base: usize, _len: usize) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)] // now only called under `hookdiag`; shim kept for symmetry
pub fn log_callers(_label: &str) {}
#[cfg(not(feature = "hookdiag"))]
#[inline(always)]
#[allow(dead_code)]
pub fn log_callers_depth(_label: &str, _max: usize) {}
