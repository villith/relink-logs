use std::ptr::NonNull;

use anyhow::{anyhow, Result};
use protocol::{ActionType, Actor, DamageEvent, Message};
use retour::static_detour;

use crate::{event, hooks::diag::readable, hooks::ffi::DamageInstance, process::Process};

use super::{actor_idx, actor_type_id};

type ProcessDamageEventFunc =
    unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;

// v2.0.2: `StatusBase::getDotDamage(StatusBase* status /*rcx*/, DotDamage* out /*rdx*/)`.
// The shared prologue (`mov rsi,rdx; mov rdi,rcx`, r8/r9 never read) confirms **2 args** —
// the previous 4-arg declaration described the wrong function entirely (see PROCESS_DOT_SIG).
type ProcessDotEventFunc = unsafe extern "system" fn(*const usize, *const usize) -> usize;

static_detour! {
    static ProcessDamageEvent: unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;
    // The reaction-less direct-apply path (see PROCESS_DAMAGE_BYPASS_SIG): void,
    // 3 args (receiver, damage instance, mode flag).
    static ProcessDamageBypass: unsafe extern "system" fn(*const usize, *const usize, u32);
    // One detour per DoT-dealing status subclass; see PROCESS_DOT_SIG.
    static ProcessDotEvent0: unsafe extern "system" fn(*const usize, *const usize) -> usize;
    static ProcessDotEvent1: unsafe extern "system" fn(*const usize, *const usize) -> usize;
    static ProcessDotEvent2: unsafe extern "system" fn(*const usize, *const usize) -> usize;
}

#[cfg(feature = "hookdiag")]
static_detour! {
    // The game's damage-number display fn (`OnAttackApplyAndSetupForDisplay`,
    // entry 0x1fbe120; sig from the overcap RE, still unique on v2.0.2).
    static DisplayDamage: unsafe extern "system" fn(*const usize, *const usize) -> usize;
}

#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("ProcessDamageEvent", &ProcessDamageEvent);
    super::disable_quiet("ProcessDamageBypass", &ProcessDamageBypass);
    super::disable_quiet("ProcessDotEvent0", &ProcessDotEvent0);
    super::disable_quiet("ProcessDotEvent1", &ProcessDotEvent1);
    super::disable_quiet("ProcessDotEvent2", &ProcessDotEvent2);
    #[cfg(feature = "hookdiag")]
    super::disable_quiet("DisplayDamage", &DisplayDamage);
}

/// DISPDIAG hook target: The World's guarded-Quickening counter damage (a
/// scripted 1%-max-HP hit, 27.7M on Defy Infinity) reaches the SCREEN without
/// passing ProcessDamageEvent or the direct-apply bypass (0 ALTDMG lines,
/// 07-21) — so log every display call's instance fields to catch the render
/// path of numbers the damage hooks never see.
#[cfg(feature = "hookdiag")]
const DISPLAY_DAMAGE_SIG: &str = "' 41 57 41 56 41 55 41 54 56 57 55 53 48 81 ec ? ? ? ? \
     c5 f8 29 b4 24 ? ? ? ? 48 89 d6 48 89 cf 48 8b 42";

/// The World's actor-type hash (`EM8300`, XXHash32Custom of the capitalized
/// id — same id space as `lang/*/enemies.json` keys). Gates the
/// guarded-Quickening marker so action-0 guard-flagged events from other
/// content can't count as a Quickening guard.
const EM8300_THE_WORLD: u32 = 0xd7ba6d4a;

/// Supplementary-damage ("echo") flag. A perfect guard's counter event is
/// followed ~150ms later by a supp-echo companion event with the SAME action
/// id and this bit added (live log 07-21: flags 0x40040e0020 then
/// 0x40040e8020, echo delta 0) — echo events must never count as guards or
/// every PG shows double hits.
const SUPP_ECHO_FLAG: u64 = 1 << 15;

/// Guard flag: set on a guarded (perfectly blocked) hit and on the guard's
/// marker/counter events (every live-captured counter carries it, e.g. flags
/// 0x40040e0020 on 07-21).
const GUARD_FLAG: u64 = 1 << 5;

/// Skybound Art flags. An SBA in progress fires zero-damage events EVERY FRAME
/// that reuse action id -1 (and sometimes the guard bit), so the guard
/// classifiers must exclude them — see [`is_generic_pg_counter`].
const SBA_FLAGS: u64 = 1 << 13 | 1 << 14;

/// Generic Perfect Guard counter signature: ~48ms after a guard the game fires
/// a player-sourced zero-damage event with action id -1 carrying the guard's
/// stun. Identified by signature — NOT by the stun gauge moving — because a
/// stun-immune target yields a 0 delta and the guard must still count (and
/// ONLINE the in-call delta is structurally 0, since enemy stun is
/// host-authoritative and arrives as network messages instead).
///
/// Action id -1 alone is not enough: it means "no specific action", and other
/// mechanics ride it. Live capture 07-22 (online, stored log 537) found
/// SBA-flagged zero-damage events firing ONCE PER FRAME for an SBA's whole
/// duration — 286 events over 4.67s from one player — which booked 700 phantom
/// guards in that one quest. Some of them even carry the guard bit, so the
/// counter is pinned to all three conditions: the guard flag present (every one
/// of the 173 captured real counters had it), and neither an echo companion
/// (bit 15, which shadows every real counter ~150ms later) nor an SBA.
fn is_generic_pg_counter(action_id: u32, flags: u64) -> bool {
    action_id == u32::MAX
        && flags & GUARD_FLAG != 0
        && flags & SUPP_ECHO_FLAG == 0
        && flags & SBA_FLAGS == 0
}

/// Guarded-Quickening marker signature: on a guarded Quickening The World
/// fires a zero-damage player-sourced event with action id 0 + guard flag
/// (bit 5). Gated on the target being The World — action-0 guard-flagged
/// events are not proven unique to it. Echo companions (bit 15) are excluded,
/// see [`SUPP_ECHO_FLAG`].
fn is_quickening_marker(action_id: u32, flags: u64, target_type_id: u32) -> bool {
    action_id == 0
        && flags & GUARD_FLAG != 0
        && flags & SUPP_ECHO_FLAG == 0
        && target_type_id == EM8300_THE_WORLD
}

/// What a player-sourced ZERO-damage event should be surfaced as. Pure so both
/// damage detours share one authority and the decision is unit-tested.
#[derive(Debug, PartialEq, Eq)]
enum ZeroDamageGuard {
    /// Nothing to emit.
    None,
    /// The World's guarded Quickening (hits-only marker row).
    Quickening,
    /// A genuine Perfect Guard counter (the game's generic action-id -1 counter).
    PerfectGuard,
    /// A NON-guard player zero-damage stun accrual. Live-confirmed 07-21 to be an
    /// Eugen stun-application proc — the sticky grenade applying stun when it
    /// sticks to a target (action id 0, flags 0x6100000, no guard bit, flat ~25
    /// stun). Previously mis-surfaced as a Perfect Guard because the old rule
    /// admitted ANY positive stun delta.
    StunEffect,
}

/// Classify a player-sourced zero-damage event. Only the generic counter
/// (action -1) is a Perfect Guard; a bare positive stun delta without the guard
/// signature is a non-guard melee-stun accrual, not a guard.
fn classify_zero_damage_guard(
    action_id: u32,
    flags: u64,
    added_stun_value: f32,
    target_type_id: u32,
) -> ZeroDamageGuard {
    // Echo companions never classify — one rides ~150ms behind every guard and
    // would double the count.
    if flags & SUPP_ECHO_FLAG != 0 {
        return ZeroDamageGuard::None;
    }
    if is_quickening_marker(action_id, flags, target_type_id) {
        return ZeroDamageGuard::Quickening;
    }
    if is_generic_pg_counter(action_id, flags) {
        return ZeroDamageGuard::PerfectGuard;
    }
    if added_stun_value > 0.0 {
        return ZeroDamageGuard::StunEffect;
    }
    ZeroDamageGuard::None
}

/// Flag-bit → [`ActionType`] classification, shared by both damage detours so
/// the bit table can never diverge between them.
fn classify_action_type(flags: u64, action_id: u32) -> ActionType {
    if ((1 << 7 | 1 << 50) & flags) != 0 {
        ActionType::LinkAttack
    } else if (SBA_FLAGS & flags) != 0 {
        ActionType::SBA
    } else if (SUPP_ECHO_FLAG & flags) != 0 {
        ActionType::SupplementaryDamage(action_id)
    } else {
        ActionType::Normal(action_id)
    }
}

/// Delta of a guarded f32 read across the original call; either side
/// unavailable reports no delta rather than faulting. Only a finite positive
/// delta is real: a shifted accumulator offset after a future patch can read
/// NaN/inf, and this value flows unguarded into stun totals (which serialize to
/// JSON `null` when non-finite), so reject anything that isn't a clean number —
/// the same defensive rule `base_damage` uses.
fn f32_delta(previous: Option<f32>, current: Option<f32>) -> f32 {
    match (previous, current) {
        (Some(prev), Some(cur)) => {
            let delta = cur - prev;
            if delta.is_finite() && delta > 0.0 {
                delta
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/// The source specified instance behind a damage event's `a2`:
/// `a2+0x18 -> entity -> +0x70`, both hops guarded; `None` for a
/// null/unreadable source.
fn damage_source_instance_ptr(a2: *const usize) -> Option<usize> {
    // Same two-hop specified-instance resolution as every other parent link;
    // reuse the shared SEH-guarded, unit-tested helper so the version-fragile
    // +0x70 offset and its null checks live in exactly one place.
    super::parent_specified_instance_at(a2, 0x18).map(|p| p as usize)
}

/// Per-target budget for the stun_scan window probe (module-scoped so it can be
/// RESET on quest load). `first_n_per_key` tracks at most 64 distinct keys EVER —
/// the 2026-07-18 online run proved that town/solo play earlier in the same game
/// session exhausts all 64 before the online quest starts, so the probe never
/// sampled the lobby at all. Clearing on each quest load gives every quest a
/// fresh budget.
#[cfg(feature = "hookdiag")]
pub(crate) static STUN_SCAN_PER_TARGET: std::sync::Mutex<Vec<(usize, u32)>> =
    std::sync::Mutex::new(Vec::new());

/// Reset the stun_scan per-target budget (called from the quest-load hook).
#[cfg(feature = "hookdiag")]
pub(crate) fn reset_stun_scan_budget() {
    if let Ok(mut entries) = STUN_SCAN_PER_TARGET.try_lock() {
        entries.clear();
    }
}

/// Between-call stun tracker (hookdiag): last post-call `+0xB90` value per actor
/// instance, sampled whenever a damage event touches the actor as source or
/// target. A PRE-call read HIGHER than the stored value is stun that accrued
/// OUTSIDE every damage call — the signature of an async apply. This is the
/// Perfect Guard discriminator: the 2026-07-21 PGDIAG run proved guarded hits
/// (flags bit 5, dmg 0) add nothing synchronously and no stun message fires
/// solo, so a PG accrual can only appear as one of these jumps. Unbudgeted.
/// Pointer reuse across waves can false-positive; the dt in the log exposes it.
#[cfg(feature = "hookdiag")]
static B90_LAST_SEEN: std::sync::Mutex<Vec<(usize, f32, u128)>> = std::sync::Mutex::new(Vec::new());

#[cfg(feature = "hookdiag")]
fn b90_check_unattributed(label: &str, ptr: usize, pre: f32) {
    if let Ok(track) = B90_LAST_SEEN.try_lock() {
        if let Some((_, last, t_last)) = track.iter().find(|entry| entry.0 == ptr) {
            if pre > *last + 0.01 {
                log::info!(
                    "UNATTRB90 t={} {label} ptr={ptr:#x} b90 {last:.3} -> {pre:.3} (+{:.3}) dt_ms={}",
                    crate::hooks::diag::ms(),
                    pre - *last,
                    crate::hooks::diag::ms().saturating_sub(*t_last),
                );
            }
        }
    }
}

/// PG watch (hookdiag): full-window Perfect Guard discriminator. For every
/// enemy→player hit the ATTACKER's f32 window (0x000..0x1800) is snapshotted
/// pre- and post-call: the in-call diff catches a stun applied synchronously to
/// ANY field during the guarded hit (not just +0xB90 — the 07-21 dummy run
/// proved +0xB90 itself never moves), and the post-call window stays armed so
/// the NEXT event touching that actor diffs against it, catching an async apply
/// landing between calls. One armed watch at a time (last attacker wins).
#[cfg(feature = "hookdiag")]
#[allow(clippy::type_complexity)]
static PG_WATCH: std::sync::Mutex<Option<(usize, Vec<f32>, u128)>> = std::sync::Mutex::new(None);

#[cfg(feature = "hookdiag")]
fn pg_watch_check(target_ptr: usize, source_ptr: Option<usize>) {
    if let Ok(mut watch) = PG_WATCH.try_lock() {
        if let Some((ptr, saved, t_armed)) = watch.as_ref() {
            if *ptr == target_ptr || Some(*ptr) == source_ptr {
                let now = crate::hooks::diag::ms();
                let current = crate::hooks::diag::snapshot_f32_window(*ptr, 0x000, 0x1800);
                // The check line always logs (negative evidence matters: "sampled,
                // nothing rose"); the increase line below is quiet when empty.
                log::info!(
                    "PGWATCH check t={now} ptr={ptr:#x} dt_ms={}",
                    now.saturating_sub(*t_armed)
                );
                crate::hooks::diag::log_f32_increases("pg_watch", *ptr, 0x000, saved, &current);
                *watch = None;
            }
        }
    }
}

#[cfg(feature = "hookdiag")]
fn pg_watch_arm(source_ptr: usize, pre_window: &[f32], flags: u64) {
    let post_window = crate::hooks::diag::snapshot_f32_window(source_ptr, 0x000, 0x1800);
    // In-call diff: anything the guarded hit applied to the attacker DURING the
    // original call, at any offset.
    crate::hooks::diag::log_f32_increases("pg_incall", source_ptr, 0x000, pre_window, &post_window);
    if let Ok(mut watch) = PG_WATCH.try_lock() {
        log::info!(
            "PGWATCH armed t={} ptr={source_ptr:#x} flags={flags:#x}",
            crate::hooks::diag::ms()
        );
        *watch = Some((source_ptr, post_window, crate::hooks::diag::ms()));
    }
}

#[cfg(feature = "hookdiag")]
fn b90_record(ptr: usize, value: f32) {
    if let Ok(mut track) = B90_LAST_SEEN.try_lock() {
        let now = crate::hooks::diag::ms();
        if let Some(entry) = track.iter_mut().find(|entry| entry.0 == ptr) {
            entry.1 = value;
            entry.2 = now;
        } else {
            if track.len() >= 16 {
                // Evict the stalest entry (dead/despawned actors age out naturally).
                if let Some(oldest) = track
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, entry)| entry.2)
                    .map(|(i, _)| i)
                {
                    track.swap_remove(oldest);
                }
            }
            track.push((ptr, value, now));
        }
    }
}

#[derive(Clone)]
pub struct OnProcessDamageHook {
    tx: event::Tx,
}

const PROCESS_DAMAGE_EVENT_SIG: &str = "e8 $ { ' } 66 83 bc 24 ? ? ? ? ?";

/// Direct-entry signature for the PDE-BYPASS damage path `FUN_141fbd260`: the
/// damage-message deserializer (`FUN_1429376b0`) routes an event here INSTEAD of
/// ProcessDamageEvent when its bypass bit is set — no reaction processing, the
/// damage is applied straight through the receiver's vtable (slot 0x58).
/// Live-proven 2026-07-21: The World's guarded-Quickening counter damage (a
/// scripted percent-max-HP hit; 27.7M on Defy Infinity) flows ONLY through here.
/// Anchored on the preceding `ret; int3*10` padding, cursor on the entry; the
/// prologue reads rcx/rdx/r8d (3 args, matches the decompile). Verified unique,
/// target_rva=0x1fbd260.
const PROCESS_DAMAGE_BYPASS_SIG: &str = "c3 cc cc cc cc cc cc cc cc cc cc ' 41 57 41 56 41 55 \
     41 54 56 57 55 53 48 83 ec 28 44 89 c6 48 89 d7 48 89 cb 48 8b 41 08 4c 8b 30";

/// v2.0.2: the stun accumulator moved target+0xA70 -> +0xB90. Live-derived via
/// the stun_scan probe (2026-07-15, three targets across three sessions): +0xB90
/// is strictly monotonic across hits with old-scale increments, while the old
/// 0xA70 deltas 0.0 on every hit. Nearby look-alikes rejected: +0xB3C refreshes
/// to a 2.50 cap and decays (flinch timer), +0xA44 moves <0.01/hit.
const STUN_ACCUMULATOR_OFFSET: usize = 0xB90;

impl OnProcessDamageHook {
    pub fn new(tx: event::Tx) -> Self {
        OnProcessDamageHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(process_dmg_evt) = process.search_address(PROCESS_DAMAGE_EVENT_SIG) {
            #[cfg(feature = "console")]
            println!("Found process dmg event");

            unsafe {
                let func: ProcessDamageEventFunc = std::mem::transmute(process_dmg_evt);

                ProcessDamageEvent
                    .initialize(func, move |a1, a2, a3, a4| cloned_self.run(a1, a2, a3, a4))?;

                ProcessDamageEvent.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find process_dmg_evt"));
        }

        // Non-fatal: without the bypass hook everything except direct-apply events
        // (guarded-Quickening counter damage) still works.
        match process.search_address(PROCESS_DAMAGE_BYPASS_SIG) {
            Ok(bypass_addr) => {
                #[cfg(feature = "console")]
                println!("Found process dmg bypass");

                let cloned_self = self.clone();
                unsafe {
                    let func: unsafe extern "system" fn(*const usize, *const usize, u32) =
                        std::mem::transmute(bypass_addr);
                    ProcessDamageBypass
                        .initialize(func, move |a1, a2, a3| cloned_self.run_bypass(a1, a2, a3))?;
                    ProcessDamageBypass.enable()?;
                }
            }
            Err(e) => {
                log::warn!("process_damage_bypass: sig failed, direct-apply damage untracked: {e:?}");
            }
        }

        #[cfg(feature = "hookdiag")]
        match process.search_address(DISPLAY_DAMAGE_SIG) {
            Ok(display_addr) => {
                let cloned_self = self.clone();
                unsafe {
                    let func: unsafe extern "system" fn(*const usize, *const usize) -> usize =
                        std::mem::transmute(display_addr);
                    DisplayDamage
                        .initialize(func, move |a1, a2| cloned_self.run_display(a1, a2))?;
                    DisplayDamage.enable()?;
                }
                log::info!("DISPDIAG hook armed at {display_addr:#x}");
            }
            Err(e) => {
                log::warn!("display_damage: sig failed: {e:?}");
            }
        }

        Ok(())
    }

    /// DISPDIAG (hookdiag, unbudgeted): one line per damage-number display call.
    /// Fields read pre-call from the same DamageInstance layout the damage hooks
    /// use; source resolved through the entity list like everywhere else.
    #[cfg(feature = "hookdiag")]
    fn run_display(&self, a1: *const usize, a2: *const usize) -> usize {
        use crate::hooks::diag::{read_ptr_guarded, read_u32_guarded};

        let dmg = read_u32_guarded(a2 as usize, 0xD4) as i32;
        let d0 = read_u32_guarded(a2 as usize, 0xD0) as i32;
        let action = read_u32_guarded(a2 as usize, 0x16C) as i32;
        let flags = ((read_u32_guarded(a2 as usize, 0xEC) as u64) << 32)
            | read_u32_guarded(a2 as usize, 0xE8) as u64;
        let src_type = damage_source_instance_ptr(a2)
            .map(|src| actor_type_id(src as *const usize))
            .unwrap_or(0);
        let target_type = read_ptr_guarded(a1 as usize, 0x08)
            .and_then(|p| read_ptr_guarded(p, 0x00))
            .filter(|p| *p != 0)
            .map(|tgt| actor_type_id(tgt as *const usize))
            .unwrap_or(0);
        log::info!(
            "DISPDIAG t={} src_type={src_type:#010x} tgt_type={target_type:#010x} dmg={dmg} \
             d0={d0} action={action} flags={flags:#x}",
            crate::hooks::diag::ms(),
        );

        unsafe { DisplayDamage.call(a1, a2) }
    }

    /// Zero-damage guard capture, shared by BOTH damage detours so the tested
    /// classifiers are the single authority regardless of which path observed
    /// the event. A perfect guard produces no player damage event — ~48ms after
    /// the guard the game fires a PLAYER-sourced ZERO-damage event at the
    /// guarded enemy carrying the guard's stun (live-proven 07-21 on the
    /// training bot: two guards, two uncounted zero-damage events at +48/47ms,
    /// each delivering the stun in-call; regular hits never did). Zero-damage
    /// events are ignored by the parser, so the guard is emitted as its own
    /// message. The classifiers — NOT the stun gauge — decide what it is (a
    /// stun-immune target legitimately yields a 0 delta):
    ///   * Quickening marker → `OnPerfectGuardQuickening`, the dedicated
    ///     hits-only row (the gauge fills asynchronously and the scripted
    ///     counter damage is intentionally untracked)
    ///   * generic counter, or any other in-call stun accrual → `OnPerfectGuardStun`
    ///
    /// Attribution = the SOURCE player (the game itself credits the counter to
    /// the guarder); pets resolve to owners exactly like the stun-net hook.
    fn emit_zero_damage_guard(
        &self,
        source_specified_instance_ptr: usize,
        target_specified_instance_ptr: usize,
        damage_instance: &DamageInstance,
        added_stun_value: f32,
    ) {
        let action_id = damage_instance.action_id;
        let flags = damage_instance.flags;
        // A supp-echo companion (bit 15) shadows every guard ~150ms later with the
        // SAME action id; it must never count (doing so doubles the hits/stun), so
        // drop echoes up front — `classify_zero_damage_guard` also excludes them,
        // this just skips the slot/target reads below.
        if flags & SUPP_ECHO_FLAG != 0 {
            return;
        }
        // Cheap pure gate before the slot resolution + target-type read (guarded
        // pointer / vtable work this path shouldn't pay on every whiffed hit):
        // nothing can emit unless there's a generic counter, a stun accrual, or
        // the guard flag (the Quickening marker requires it).
        if !is_generic_pg_counter(action_id, flags)
            && added_stun_value <= 0.0
            && flags & GUARD_FLAG == 0
        {
            return;
        }
        let Some(actor_index) =
            super::player_slot_key_for_source(source_specified_instance_ptr as *const usize)
        else {
            return;
        };
        let event = protocol::OnPlayerStunEvent {
            actor_index,
            stun_amount: added_stun_value,
        };
        let target_type_id = actor_type_id(target_specified_instance_ptr as *const usize);
        // The classifiers — NOT the stun gauge — decide what this is. Only the
        // generic counter (action -1) is a Perfect Guard; a bare stun delta with no
        // guard signature is a stun-application proc (Eugen's sticky grenade), which
        // must NOT inflate the Perfect Guard row (live-diagnosed 07-21).
        match classify_zero_damage_guard(action_id, flags, added_stun_value, target_type_id) {
            ZeroDamageGuard::Quickening => {
                let _ = self.tx.send(Message::OnPerfectGuardQuickening(event));
            }
            ZeroDamageGuard::PerfectGuard => {
                let _ = self.tx.send(Message::OnPerfectGuardStun(event));
            }
            ZeroDamageGuard::StunEffect => {
                let _ = self.tx.send(Message::OnStunEffect(event));
            }
            ZeroDamageGuard::None => {}
        }
    }

    /// Detour for the reaction-less direct-apply path (`FUN_141fbd260`). Same
    /// `a1`/`a2` layouts as ProcessDamageEvent (the deserializer hands both
    /// branches the same stack object); `a3` is a small mode flag. Emits a
    /// standard DamageEvent so the parser attributes it like any other hit. A
    /// scripted percent-HP hit can leave the damage field 0 — the in-call target
    /// HP drop is the applied damage then.
    fn run_bypass(&self, a1: *const usize, a2: *const usize, a3: u32) {
        use crate::hooks::diag::{read_f32_guarded, read_ptr_guarded};

        let target_specified_instance_ptr =
            match read_ptr_guarded(a1 as usize, 0x08).and_then(|p| read_ptr_guarded(p, 0x00)) {
                Some(ptr) if ptr != 0 => ptr,
                _ => return unsafe { ProcessDamageBypass.call(a1, a2, a3) },
            };
        let pre_call_source_ptr = damage_source_instance_ptr(a2);

        let previous_stun_value =
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);
        let target_pre_hp = read_target_hp_pair(target_specified_instance_ptr);

        unsafe { ProcessDamageBypass.call(a1, a2, a3) };

        let source_specified_instance_ptr = match pre_call_source_ptr {
            Some(ptr) => ptr,
            None => return,
        };

        let damage_instance = unsafe { NonNull::new(a2 as *mut DamageInstance).unwrap().as_ref() };

        let added_stun_value = f32_delta(
            previous_stun_value,
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET),
        );
        let (target_current_hp, target_max_hp) =
            read_target_hp_pair(target_specified_instance_ptr).unzip();
        let hp_drop: i64 = match (target_pre_hp, target_current_hp) {
            (Some((pre_cur, _)), Some(post_cur)) => pre_cur as i64 - post_cur as i64,
            _ => 0,
        };

        let damage = if damage_instance.damage > 0 {
            damage_instance.damage
        } else {
            hp_drop.clamp(0, i32::MAX as i64) as i32
        };

        let source_type_id = actor_type_id(source_specified_instance_ptr as *const usize);
        let source_idx = actor_idx(source_specified_instance_ptr as *const usize);
        let (source_parent_type_id, source_parent_idx) = super::player_keyed_parent(
            source_type_id,
            source_idx,
            source_specified_instance_ptr as *const usize,
        );

        #[cfg(feature = "hookdiag")]
        {
            let target_type_id = actor_type_id(target_specified_instance_ptr as *const usize);
            log::info!(
                "ALTDMG t={} src_type={source_type_id:#010x} parent={source_parent_type_id:#010x}/\
                 {source_parent_idx:#x} tgt_type={target_type_id:#010x} a3={a3} dmg_field={} \
                 used={damage} flags={:#x} action={} cap={} precap={:.1} \
                 stun_delta={added_stun_value:.3} hp_drop={hp_drop} \
                 tgt_hp={target_current_hp:?}/{target_max_hp:?}",
                crate::hooks::diag::ms(),
                damage_instance.damage,
                damage_instance.flags,
                damage_instance.action_id,
                damage_instance.damage_cap,
                damage_instance.base_damage,
            );
            // Unresolved source: run the parent scan so the owner-entity offset
            // for a new proxy actor can be derived from the log.
            let source_ptr = source_specified_instance_ptr as *const usize;
            if super::get_source_parent(source_type_id, source_ptr).is_none()
                && super::player::player_slot_key_for_actor(source_ptr).is_none()
            {
                crate::hooks::diag::probe_unmapped_source_parent(
                    source_specified_instance_ptr,
                    source_type_id,
                );
            }
        }

        if damage <= 0 {
            // Nothing measurable applied; classify and surface a guard event
            // exactly like the main path's zero-damage branch.
            self.emit_zero_damage_guard(
                source_specified_instance_ptr,
                target_specified_instance_ptr,
                damage_instance,
                added_stun_value,
            );
            return;
        }

        let _ = self.tx.send(Message::DamageEvent(build_damage_event(
            damage_instance,
            Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target_specified_instance_ptr,
            damage,
            added_stun_value,
            target_current_hp,
            target_max_hp,
        )));
    }

    fn run(&self, a1: *const usize, a2: *const usize, a3: *const usize, a4: u8) -> usize {
        // hookdiag: process_damage still resolves; log its callers once so we can locate
        // the adjacent (broken) death handler. Fires constantly, so log only the first N.
        #[cfg(feature = "hookdiag")]
        {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            if crate::hooks::diag::first_n(&N, 3) {
                crate::hooks::diag::log_callers("process_damage");
            }
        }

        // Target is the instance of the actor being damaged.
        // For example: Instance of the Em2700 class.
        //
        // All of these actor derefs are VirtualQuery-guarded (read_ptr/f32_guarded): a NEW
        // character can be a `Pl####` class with a different instance layout, so an offset
        // valid for known actors may fall outside its allocation. A guarded read returns None
        // there and we bail — the game's own damage processing STILL runs (we never skip
        // ProcessDamageEvent.call), we only skip emitting our own event. Previously these were
        // raw derefs that hard-faulted the game thread on an unfamiliar actor (silent freeze).
        use crate::hooks::diag::{read_f32_guarded, read_ptr_guarded};

        // a1+0x08 -> *ptr -> target specified instance. Two hops, each guarded.
        let target_specified_instance_ptr =
            match read_ptr_guarded(a1 as usize, 0x08).and_then(|p| read_ptr_guarded(p, 0x00)) {
                Some(ptr) if ptr != 0 => ptr,
                _ => return unsafe { ProcessDamageEvent.call(a1, a2, a3, a4) },
            };

        let previous_stun_value =
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);

        #[cfg(feature = "hookdiag")]
        if let Some(pre) = previous_stun_value {
            b90_check_unattributed("tgt", target_specified_instance_ptr, pre);
        }

        // +0xB30: written by instant-stun effects (+20.0 on The World's guarded
        // Quickening, +15.0 on the training bot — both in-call) — distinct from the
        // +0xB90 gauge. NOT stun-duration seconds (The World recovers much faster
        // than 20s); semantics unknown. Sampled for PGCOUNTER diagnostics.
        #[cfg(feature = "hookdiag")]
        let target_pre_b30 = read_f32_guarded(target_specified_instance_ptr, 0xB30);

        // Target HP before the call: a guarded-Quickening counter can apply damage
        // that never shows in the damage field (Defy Infinity 27.7M, 07-21) — the
        // in-call HP delta is the only way to see it.
        #[cfg(feature = "hookdiag")]
        let target_pre_hp = read_target_hp_pair(target_specified_instance_ptr);

        // Source extracted BEFORE the original call (the post-call code reuses
        // this pointer for attribution).
        let pre_call_source_ptr = damage_source_instance_ptr(a2);

        // SOURCE-side accumulator snapshot, diagnostics only: the 07-21 sessions
        // proved the guarded hit itself never moves the ATTACKER's accumulator —
        // the guard's stun arrives as a separate zero-damage counter event
        // handled in the zero-damage branch below. Release builds skip the
        // guarded read entirely (this path runs on every damage event).
        #[cfg(feature = "hookdiag")]
        let source_previous_stun =
            pre_call_source_ptr.and_then(|src| read_f32_guarded(src, STUN_ACCUMULATOR_OFFSET));

        #[cfg(feature = "hookdiag")]
        if let (Some(src), Some(pre)) = (pre_call_source_ptr, source_previous_stun) {
            b90_check_unattributed("src", src, pre);
        }

        // Cross-event PG watch: if a prior enemy→player hit armed a window on this
        // event's source or target, diff it NOW (pre-call) — an async apply since
        // the arming shows up here.
        #[cfg(feature = "hookdiag")]
        pg_watch_check(target_specified_instance_ptr, pre_call_source_ptr);

        // Enemy→player hit: snapshot the attacker's full window before the call so
        // the in-call diff can catch a guard-stun applied to ANY of its fields.
        #[cfg(feature = "hookdiag")]
        let pg_pre_window: Option<(usize, Vec<f32>)> = pre_call_source_ptr.and_then(|src| {
            let target_is_player = super::player::player_slot_key_for_actor(
                target_specified_instance_ptr as *const usize,
            )
            .is_some();
            let source_is_player =
                super::player::player_slot_key_for_actor(src as *const usize).is_some();
            (target_is_player && !source_is_player)
                .then(|| (src, crate::hooks::diag::snapshot_f32_window(src, 0x000, 0x1800)))
        });

        // Stun re-derivation probe (kept for the next patch): snapshot a float window
        // across the original call and log offsets that INCREASED; the accumulator is
        // the offset whose growth tracks hits landing.
        // Budgeted PER TARGET (a global first-48 burned the whole budget on the
        // opening trash mobs of the 2026-07-15 session and never sampled the boss),
        // hookdiag builds only.
        //
        // 2026-07-17 online finding: in a real online lobby the verified +0xB90
        // accumulator never moves — for ANY player, local included (log 405:
        // 0 stun events over 2914 hits, vs thousands offline). The window is
        // widened 0x800..0xE00 -> 0x000..0x1800 to catch an online-mode
        // accumulator living elsewhere in the instance (cost is fine: the
        // window is guarded with ONE probe, and tonight's +0xD60 blips show the
        // interesting region extends below 0x800).
        #[cfg(feature = "hookdiag")]
        let stun_probe_pre = {
            crate::hooks::diag::first_n_per_key(
                &STUN_SCAN_PER_TARGET,
                target_specified_instance_ptr,
                24,
            )
            .then(|| {
                crate::hooks::diag::snapshot_f32_window(
                    target_specified_instance_ptr,
                    0x000,
                    0x1800,
                )
            })
        };

        let original_value = unsafe { ProcessDamageEvent.call(a1, a2, a3, a4) };

        #[cfg(feature = "hookdiag")]
        if let Some(pre) = stun_probe_pre {
            let post = crate::hooks::diag::snapshot_f32_window(
                target_specified_instance_ptr,
                0x000,
                0x1800,
            );
            crate::hooks::diag::log_f32_increases(
                "stun_scan",
                target_specified_instance_ptr,
                0x000,
                &pre,
                &post,
            );
        }

        // Stun is a delta across the original call.
        let target_post_stun =
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);
        let added_stun_value = f32_delta(previous_stun_value, target_post_stun);

        #[cfg(feature = "hookdiag")]
        if let Some(post) = target_post_stun {
            b90_record(target_specified_instance_ptr, post);
        }

        // The source specified instance, extracted from the 'a2' entity list BEFORE the
        // original call (see the Perfect Guard snapshot above). Same early-return
        // semantics as the old post-call extraction: a null/unreadable source (e.g.
        // online + Ferry's Umlauf pet, @TODO(false): possible online data race) bails.
        let source_specified_instance_ptr = match pre_call_source_ptr {
            Some(ptr) => ptr,
            None => return original_value,
        };

        // hookdiag: DISABLED — the wide instance scan was too heavy for the game thread and
        // froze the game. We already captured the structure (see memory). Left here (commented)
        // as the re-enable point for a NARROW, targeted probe if needed.
        // #[cfg(feature = "hookdiag")]
        // crate::hooks::diag::probe_player_instance(source_specified_instance_ptr);

        let damage_instance = unsafe { NonNull::new(a2 as *mut DamageInstance).unwrap().as_ref() };
        let damage: i32 = damage_instance.damage;

        // Source-side accumulator delta (diagnostics; see the pre-call snapshot
        // above for why this is hookdiag-only).
        #[cfg(feature = "hookdiag")]
        {
            let source_post_stun =
                read_f32_guarded(source_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);
            let source_added_stun = f32_delta(source_previous_stun, source_post_stun);
            if let Some(post) = source_post_stun {
                b90_record(source_specified_instance_ptr, post);
            }
            // Enemy→player hit: in-call window diff + arm the cross-event watch.
            if let Some((src, pre_window)) = &pg_pre_window {
                pg_watch_arm(*src, pre_window, damage_instance.flags);
            }
            let source_is_player = super::player::player_slot_key_for_actor(
                source_specified_instance_ptr as *const usize,
            )
            .is_some();
            if !source_is_player {
                let target_slot_key = super::player::player_slot_key_for_actor(
                    target_specified_instance_ptr as *const usize,
                );
                if target_slot_key.is_some() || source_added_stun > 0.0 {
                    log::info!(
                        "PGDIAG t={} src_type={:#010x} src_ptr={source_specified_instance_ptr:#x} \
                         tgt_slot={target_slot_key:?} action={} dmg={damage} flags={:#x} \
                         src_b90 {source_previous_stun:?} -> {source_post_stun:?} \
                         delta={source_added_stun:.3}",
                        crate::hooks::diag::ms(),
                        actor_type_id(source_specified_instance_ptr as *const usize),
                        damage_instance.action_id,
                        damage_instance.flags,
                    );
                }
            }
        }
        if original_value == 0 || damage <= 0 {
            // hookdiag: log every zero-damage candidate with the diag-only
            // deltas and the resolved slot, so a mis-classified guard event can
            // be diagnosed live.
            #[cfg(feature = "hookdiag")]
            {
                // Instant-stun duration delta (+0xB30).
                let b30_delta = f32_delta(
                    target_pre_b30,
                    read_f32_guarded(target_specified_instance_ptr, 0xB30),
                );
                // In-call target HP drop: catches counter damage that bypasses
                // the damage field entirely (guarded Quickening, 07-21).
                let hp_drop: i64 = match (
                    target_pre_hp,
                    read_target_hp_pair(target_specified_instance_ptr),
                ) {
                    (Some((pre_cur, _)), Some((post_cur, _))) => pre_cur as i64 - post_cur as i64,
                    _ => 0,
                };
                let guard_flagged = damage_instance.flags & GUARD_FLAG != 0;
                if added_stun_value > 0.0
                    || b30_delta > 0.0
                    || hp_drop > 0
                    || guard_flagged
                    || damage != 0
                {
                    let source_slot_key = super::player_slot_key_for_source(
                        source_specified_instance_ptr as *const usize,
                    );
                    log::info!(
                        "PGCOUNTER t={} src_type={:#010x} tgt_type={:#010x} slot={source_slot_key:?} \
                         action={} flags={:#x} dmg={damage} ret={original_value} \
                         b90_delta={added_stun_value:.3} b30_delta={b30_delta:.3} hp_drop={hp_drop} \
                         cap={} precap={:.1}",
                        crate::hooks::diag::ms(),
                        actor_type_id(source_specified_instance_ptr as *const usize),
                        actor_type_id(target_specified_instance_ptr as *const usize),
                        damage_instance.action_id,
                        damage_instance.flags,
                        damage_instance.damage_cap,
                        damage_instance.base_damage,
                    );
                }
            }

            self.emit_zero_damage_guard(
                source_specified_instance_ptr,
                target_specified_instance_ptr,
                damage_instance,
                added_stun_value,
            );
            return original_value;
        }

        // Only the diagnostics below read the raw flags directly; the release
        // path classifies inside `build_damage_event`.
        #[cfg(any(feature = "hookdiag", feature = "dmgdiag"))]
        let flags: u64 = damage_instance.flags;

        // Struct-offset diagnostic, kept for the next game patch (a major update shifts
        // fields in the DamageInstance struct on `a2` — this is how action_id was found
        // to move 0x154 -> 0x16c in v2.0.2, and how a relocated damage_cap can be found).
        // Off by default; build with `--features hook/dmgdiag` to dump every nonzero u32
        // in a wide window per real skill hit (Normal/Supplementary, not link/SBA) to the
        // fern log (%APPDATA%\gbfr-logs\gbfr-logs.txt).
        #[cfg(feature = "dmgdiag")]
        {
            // Log EVERY event (no link/SBA gate — the flag-bit classification itself is
            // under suspicion), with the damage-field region 0xC0+ included in the window
            // (the original 0x140 start missed damage/base/flags entirely).
            use std::fmt::Write as _;
            static DIAG_N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            if crate::hooks::diag::first_n(&DIAG_N, 500) {
                // Source identity (2026-07-17): tag each dump with who dealt the
                // hit, so an online capture can separate remote players' hits
                // (whose cap/base fields read 0 in log 405) from local ones.
                let (src_type, src_idx) = match damage_source_instance_ptr(a2) {
                    Some(src) => (
                        actor_type_id(src as *const usize),
                        actor_idx(src as *const usize),
                    ),
                    None => (0, 0),
                };
                // read_unaligned throughout: this probe exists to be edited to read arbitrary
                // (possibly unaligned) offsets while chasing shifted fields after a patch, so a
                // future non-4-aligned offset must not become UB / fault the game thread.
                let action_id = unsafe { (a2.byte_add(0x16c) as *const u32).read_unaligned() };
                let dmg_d0 = unsafe { (a2.byte_add(0xd0) as *const i32).read_unaligned() };
                let dmg_d4 = unsafe { (a2.byte_add(0xd4) as *const i32).read_unaligned() };
                let rate_d8 = unsafe { (a2.byte_add(0xd8) as *const f32).read_unaligned() };
                let rate_dc = unsafe { (a2.byte_add(0xdc) as *const f32).read_unaligned() };
                let floor = unsafe { (a2.byte_add(0x2b8) as *const i32).read_unaligned() };
                let cap = unsafe { (a2.byte_add(0x2bc) as *const i32).read_unaligned() };
                let precap_f32 = unsafe { (a2.byte_add(0x2d4) as *const f32).read_unaligned() };
                let mut dump = String::new();
                for off in (0xc0usize..0x340).step_by(4) {
                    let v = unsafe { (a2.byte_add(off) as *const u32).read_unaligned() };
                    if v != 0 {
                        let _ = write!(dump, "[0x{:x}]={} ", off, v);
                    }
                }
                log::info!(
                    "DMGDIAG src_type={src_type:#010x} src_idx={src_idx} unk@d0={} dmg@d4={} rate@d8={} rate@dc={} flags@e8={:#x} action@16c={} floor@2b8={} cap@2bc={} precap@2d4={} nonzero: {}",
                    dmg_d0,
                    dmg_d4,
                    rate_d8,
                    rate_dc,
                    flags,
                    action_id,
                    floor,
                    cap,
                    precap_f32,
                    dump
                );
            }
        }

        // Get the source actor's type ID.
        let source_type_id = actor_type_id(source_specified_instance_ptr as *const usize);
        let source_idx = actor_idx(source_specified_instance_ptr as *const usize);

        // Game 2.0.2: resolve this actor to a cached player identity (name + party
        // slot) and publish it, since the full player_load hook no longer fires.
        // Returns None for enemies/NPCs and players not yet cached — cheap no-op then.
        if let Some(identity) = super::player::identity_event_for_actor(
            source_specified_instance_ptr as *const usize,
            source_type_id,
            source_idx,
        ) {
            // This instance resolved to a player identity — remember it so the
            // Pl2000 parent scan below has real player instances to search for.
            #[cfg(feature = "hookdiag")]
            crate::hooks::diag::note_player_instance(source_specified_instance_ptr);

            let _ = self.tx.send(Message::PlayerIdentityEvent(identity));
        }

        // A recruited crewmate Id fights entirely as its Pl2000 dragon actor — the
        // Pl1900 base actor may never deal a hit, so the source-keyed publish above
        // never fires for that player and its party slot stays empty (no Builds
        // entry, fallback bar color; live logs 344-346, 2026-07-23). Resolve the
        // dragon's owner and publish identity from the owner actor instead; the
        // parser slot-scopes the event, so two Ids in one party stay distinct.
        if source_type_id == super::ID_DRAGON_TYPE {
            if let Some((parent_type_id, parent_idx, parent_ptr)) = super::get_source_parent(
                source_type_id,
                source_specified_instance_ptr as *const usize,
            ) {
                if let Some(identity) =
                    super::player::identity_event_for_actor(parent_ptr, parent_type_id, parent_idx)
                {
                    let _ = self.tx.send(Message::PlayerIdentityEvent(identity));
                }
            }
        }

        #[cfg(feature = "hookdiag")]
        if source_type_id == super::ID_DRAGON_TYPE {
            crate::hooks::diag::probe_pl2000_parent(source_specified_instance_ptr);
        }

        // Unmapped-source probe (2026-07-20, Cagliostro Pain Train / Alexandria): a
        // source that neither maps to a parent nor is a player itself is exactly what
        // the parser silently drops, so these skills never reach the meter. Unbudgeted
        // by request: EVERY unmapped hit logs (action id ties the actor to the skill
        // that spawned it), and the parent scan rescans until it finds the owner-entity
        // offset a new `get_source_parent` arm needs.
        #[cfg(feature = "hookdiag")]
        {
            let source_ptr = source_specified_instance_ptr as *const usize;
            if super::get_source_parent(source_type_id, source_ptr).is_none()
                && super::player::player_slot_key_for_actor(source_ptr).is_none()
            {
                let action_type = classify_action_type(flags, damage_instance.action_id);
                log::info!(
                    "UNSRC hit type={source_type_id:#010x} idx={source_idx} \
                     action={action_type:?} dmg={damage} flags={flags:#x}"
                );
                crate::hooks::diag::probe_unmapped_source_parent(
                    source_specified_instance_ptr,
                    source_type_id,
                );
            }
        }

        // Resolve pets/avatars to their owner, then key players by their embedded
        // record's party slot (v2.0.2: the raw index is character-scoped and merges
        // two players on the same character into one meter row).
        let (source_parent_type_id, source_parent_idx) = super::player_keyed_parent(
            source_type_id,
            source_idx,
            source_specified_instance_ptr as *const usize,
        );

        // Post-hit target HP from the ExHp component. Read AFTER the original call so
        // the killing blow reports 0. Guarded read + plausibility checks: an actor
        // class without the +0x150 embed, or a future patch shifting it, yields None
        // rather than garbage.
        let (target_current_hp, target_max_hp) =
            read_target_hp_pair(target_specified_instance_ptr).unzip();

        // PGDMG (hookdiag, unbudgeted): on some quest versions the guarded-Quickening
        // counter arrives as a NORMAL player-attributed hit with action id 0 (Chaos++
        // 07-21: "Skill 0" summed ~384k while the on-screen number was far larger).
        // Log the full damage fields + the in-call HP drop to find where the real
        // number lives (displayed dmg vs d0 vs precap base vs raw HP loss).
        #[cfg(feature = "hookdiag")]
        {
            let action_type = classify_action_type(flags, damage_instance.action_id);
            if matches!(action_type, ActionType::Normal(0)) || flags & GUARD_FLAG != 0 {
                let target_type_id = actor_type_id(target_specified_instance_ptr as *const usize);
                let hp_drop: i64 = match (target_pre_hp, target_current_hp) {
                    (Some((pre_cur, _)), Some(post_cur)) => pre_cur as i64 - post_cur as i64,
                    _ => 0,
                };
                let dmg_d0 = crate::hooks::diag::read_u32_guarded(a2 as usize, 0xD0) as i32;
                log::info!(
                    "PGDMG t={} src_type={source_type_id:#010x} src_idx={source_idx} \
                     tgt_type={target_type_id:#010x} action={:?} dmg={damage} d0={dmg_d0} \
                     flags={:#x} cap={} precap={:.1} stun_delta={added_stun_value:.3} \
                     hp_drop={hp_drop} tgt_hp={target_current_hp:?}/{target_max_hp:?}",
                    crate::hooks::diag::ms(),
                    action_type,
                    damage_instance.flags,
                    damage_instance.damage_cap,
                    damage_instance.base_damage,
                );
            }
        }

        let _ = self.tx.send(Message::DamageEvent(build_damage_event(
            damage_instance,
            Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target_specified_instance_ptr,
            damage,
            added_stun_value,
            target_current_hp,
            target_max_hp,
        )));

        original_value
    }
}

#[derive(Clone)]
pub struct OnProcessDotHook {
    tx: event::Tx,
}

/// Entry signature for `StatusBase::getDotDamage` — the per-tick DoT damage calculator.
///
/// v2.0.2 rewrote this path and is why no DoT event has been recorded since 2026-07-01.
/// Pre-2.0.2 the calculator was a single directly-called function, which the old sig found
/// by following its `call`. In 2.0.2 it became a **virtual** (vtable slot 9, `+0x48`), so
/// the direct call no longer exists; the sig re-anchored on the surviving byte idiom landed
/// on an unrelated queue-pop helper (0x477cdb0) that never touches a status, so the hook
/// installed cleanly and emitted nothing.
///
/// Established in Ghidra (`gbfr202fast`):
///   * `ExStatus::update` (0x140bdc560) is the ONLY caller — it invokes slot 9 once per
///     ticking status, sums the results and applies them to the target.
///   * Of the 168 `StatusBase` subclasses only three override slot 9: poison (0x3b871f0),
///     burn (0x3b87f30) and darkburn/`StatusAilmentDimensionDamage` (0x3b8a3d0). The other
///     165 inherit a base that reports zero damage.
///   * Those three compile to a byte-identical prologue, so this one pattern resolves to
///     exactly those three entries (verified: 3 matches, no false positives) and each is
///     detoured. The pattern starts at the entry, so `search_match_addresses` returns the
///     entries directly — no `call` to follow.
///
/// The out-descriptor the getter fills:
///   * `+0x00` u32 status id
///   * `+0x04` i32 DoT type — 0 poison, 1 burn, 2 darkburn (the inherited base writes -1);
///     this is what finally populates [`ActionType::DamageOverTime`]'s type field, which
///     was hardcoded to 0 while the type was unknown
///   * `+0x08` `const char*` debug name (`"poison_dot"`, `"darkburn_dot"`)
///   * `+0x10` f32 damage for this tick
const PROCESS_DOT_SIG: &str = "' 41 57 41 56 41 55 41 54 56 57 55 53 48 83 ec 78 c5 f8 29 7c 24 60 \
                               c5 f8 29 74 24 50 48 89 d6 48 89 cf 8b 49 10 31 db 85 c9 74 67 48 8b \
                               47 18 4c 8b 47 20 48 8b 15";

/// How many `getDotDamage` overrides [`PROCESS_DOT_SIG`] is expected to resolve to.
const DOT_OVERRIDE_COUNT: usize = 3;

/// Reads the per-tick damage (f32 at `out+0x10`) as an `i32`, or `None` when the
/// descriptor isn't readable or the value isn't a sane damage number.
fn read_dot_damage(out: *const usize) -> Option<i32> {
    let damage = crate::hooks::diag::read_f32_guarded(out as usize, 0x10)?;
    // The game itself truncates this float to an int before applying it.
    if !damage.is_finite() || damage < 0.0 || damage > i32::MAX as f32 {
        return None;
    }
    Some(damage as i32)
}

/// Reads the DoT type (i32 at `out+0x04`). The inherited no-damage base writes -1; callers
/// only reach this after a positive damage read, so clamp anything negative to 0.
fn read_dot_type(out: *const usize) -> u32 {
    // Unreadable reads 0, which is already the clamp target for the base class's -1.
    (crate::hooks::diag::read_u32_guarded(out as usize, 0x4) as i32).max(0) as u32
}

impl OnProcessDotHook {
    pub fn new(tx: event::Tx) -> Self {
        OnProcessDotHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let addrs = process.search_match_addresses(PROCESS_DOT_SIG)?;

        #[cfg(feature = "console")]
        println!("Found {} process dot event entries", addrs.len());

        // MORE than three means the pattern started catching functions Ghidra never
        // verified. Detouring one transmutes it to this 2-arg signature, so re-calling the
        // original leaves r8/r9 unmarshalled in a callee that wanted them — the corruption
        // class that made sba_update write a negative gauge. Refuse: `try_step` logs FAIL
        // and every other hook still installs, which beats corrupting game state.
        if addrs.len() > DOT_OVERRIDE_COUNT {
            return Err(anyhow!(
                "process_dot: PROCESS_DOT_SIG matched {} entries, expected {DOT_OVERRIDE_COUNT} \
                 getDotDamage overrides — the pattern is over-broad and would detour unverified \
                 functions; re-derive it",
                addrs.len()
            ));
        }

        // FEWER is safe (every match is still a genuine hit of a very specific pattern),
        // just incomplete — one DoT type would stop reporting. Warn loudly instead.
        if addrs.len() < DOT_OVERRIDE_COUNT {
            log::warn!(
                "process_dot: expected {DOT_OVERRIDE_COUNT} getDotDamage overrides, found {} — \
                 DoT tracking is incomplete; re-derive PROCESS_DOT_SIG",
                addrs.len()
            );
        }

        // `retour`'s static detours are distinct statics, so each override needs its own.
        // The closure re-calls ITS OWN original and then emits from the shared `emit`.
        macro_rules! attach {
            ($detour:ident, $addr:expr) => {{
                let cloned_self = self.clone();
                unsafe {
                    let func: ProcessDotEventFunc = std::mem::transmute($addr);
                    $detour.initialize(func, move |status, out| {
                        let original_value = $detour.call(status, out);
                        cloned_self.emit(status, out);
                        original_value
                    })?;
                    $detour.enable()?;
                }
            }};
        }

        if let Some(&addr) = addrs.first() {
            attach!(ProcessDotEvent0, addr);
        }
        if let Some(&addr) = addrs.get(1) {
            attach!(ProcessDotEvent1, addr);
        }
        if let Some(&addr) = addrs.get(2) {
            attach!(ProcessDotEvent2, addr);
        }

        Ok(())
    }

    /// Emits one [`Message::DamageEvent`] for a DoT tick, called after the game's own
    /// `getDotDamage` has filled `out`.
    ///
    /// `status` is the `StatusBase` instance (e.g. `StatusAilmentPoison`), whose layout is
    /// unchanged from pre-2.0.2 and re-verified in the 2.0.2 decompilation:
    ///   * `+0x18` → target `CEntityInfo` (what is being damaged), actor at `+0x70`
    ///   * `+0x30` → source `CEntityInfo` (who applied the DoT), actor at `+0x70`
    ///   * `+0x50` → f32 remaining duration
    ///
    /// `out` is the descriptor the getter just wrote (see [`PROCESS_DOT_SIG`]).
    fn emit(&self, status: *const usize, out: *const usize) {
        // The getter is called for every ticking status including the ones whose base
        // implementation reports no damage, so drop zero/absent damage before doing any work.
        let dmg = match read_dot_damage(out) {
            Some(dmg) if dmg > 0 => dmg,
            _ => return,
        };
        let dot_type = read_dot_type(out);

        if !readable(status as usize, 0x58) {
            return;
        }

        // @TODO(false): There's a better way to check null pointers with Option type, but I'm too dumb to figure it out right now.
        let target_info = unsafe { status.byte_add(0x18).read() } as *const usize;
        let source_info = unsafe { status.byte_add(0x30).read() } as *const usize;

        if !readable(target_info as usize, 0x78) || !readable(source_info as usize, 0x78) {
            return;
        }

        let target = unsafe { target_info.byte_add(0x70).read() } as *const usize;
        let source = unsafe { source_info.byte_add(0x70).read() } as *const usize;

        // `actor_idx` raw-reads +0x170 and `actor_type_id` CALLS through the vtable slot at
        // +0x58 — a stale actor pointer there faults the game thread or jumps through
        // garbage. Null alone is not enough: prove the instance spans both offsets first.
        // This path only started running when the 2.0.2 signature fix made it resolve, so
        // it had never actually been exercised in the game before.
        const ACTOR_SPAN: usize = 0x174; // covers the vtable ptr at +0x00 and idx at +0x170
        if !readable(target as usize, ACTOR_SPAN) || !readable(source as usize, ACTOR_SPAN) {
            return;
        }

        let source_idx = actor_idx(source);
        let source_type_id = actor_type_id(source);

        let target_idx = actor_idx(target);
        let target_type_id = actor_type_id(target);

        let (source_parent_type_id, source_parent_idx) =
            super::player_keyed_parent(source_type_id, source_idx, source);

        let event = Message::DamageEvent(DamageEvent {
            source: Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target: Actor {
                // Same per-spawn id scheme as the damage hook, so id-based
                // target filtering keeps a summon's DoT ticks with its hits.
                index: target_spawn_id(target as usize),
                actor_type: target_type_id,
                parent_index: target_idx,
                parent_actor_type: target_type_id,
            },
            damage: dmg,
            flags: 0,
            action_id: ActionType::DamageOverTime(dot_type),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
            target_current_hp: None,
            target_max_hp: None,
        });

        let _ = self.tx.send(event);
    }
}

/// Assembles the [`DamageEvent`] both damage detours emit, so the send-side
/// rules live in exactly one place: flag classification, the
/// supplementary-damage cap/stun strip, the no-cap sentinel, the base-damage
/// sanity guard and the per-spawn target id.
fn build_damage_event(
    damage_instance: &DamageInstance,
    source: Actor,
    target_specified_instance_ptr: usize,
    damage: i32,
    added_stun_value: f32,
    target_current_hp: Option<u64>,
    target_max_hp: Option<u64>,
) -> DamageEvent {
    let flags = damage_instance.flags;
    let action_type = classify_action_type(flags, damage_instance.action_id);
    let is_supplementary = matches!(action_type, ActionType::SupplementaryDamage(_));

    // Supplementary damage is never subject to the damage cap; the cap value on
    // its instance belongs to the hit that TRIGGERED it. Send no cap so it can
    // never count as a capped hit, and no stun for the same reason. (The parser
    // enforces the same rule for events already recorded in old logs.)
    //
    // v2.0.2: "no cap" now arrives as the 99,999,999 sentinel (the game
    // normalizes a -1 cap to it) rather than 0 — send None for both so cap
    // detection stays off for uncapped hits.
    let damage_cap = (!is_supplementary
        && damage_instance.damage_cap > 0
        && damage_instance.damage_cap < 99_999_999)
        .then_some(damage_instance.damage_cap);

    // Pre-cap base damage (game's DamageInstance +0x2D4). Only meaningful alongside a
    // real cap, so send it only for cappable hits — the parser uses base > cap for exact
    // cap detection and (base/cap)*100 for the game's overcap %. Guard against garbage
    // (NaN/inf/negative) so a shifted offset after a future patch can't poison the parser.
    let base_damage = damage_cap.and_then(|_| {
        let b = damage_instance.base_damage;
        (b.is_finite() && b > 0.0).then_some(b)
    });

    let target_type_id = actor_type_id(target_specified_instance_ptr as *const usize);
    DamageEvent {
        source,
        target: Actor {
            // Per-spawn id, NOT the game index: sibling summons collapse to
            // one game index (Lucilius' three swords), so the instance
            // pointer is the only discriminator between actors alive at the
            // same time. Consumers group targets by `parent_index`; `index`
            // exists to tell simultaneous same-kind actors apart.
            index: target_spawn_id(target_specified_instance_ptr),
            actor_type: target_type_id,
            parent_index: actor_idx(target_specified_instance_ptr as *const usize),
            parent_actor_type: target_type_id,
        },
        damage,
        flags,
        action_id: action_type,
        attack_rate: Some(damage_instance.attack_rate),
        damage_cap,
        stun_value: (!is_supplementary).then_some(added_stun_value),
        base_damage,
        target_current_hp,
        target_max_hp,
    }
}

/// Per-spawn id for a TARGET actor, folded from its instance pointer. The
/// game's own actor index collapses sibling summons into one value (Lucilius'
/// three swords all report the same index across the whole fight), so the
/// instance pointer is the only stable discriminator between same-kind actors
/// alive at the same time. The low 4 bits are allocation-alignment zeros and
/// are dropped; the high half is folded in so pool-slab reuse at 4GB strides
/// still differs. A freed-and-reused instance CAN repeat an id for a later
/// spawn — the parser's respawn detection (HP jumping back to full) covers that.
fn target_spawn_id(instance: usize) -> u32 {
    ((instance >> 4) as u32) ^ ((instance >> 36) as u32)
}

/// The target's HP lives in its `ExHp` component, embedded at instance+0x150 (statically
/// derived for v2.0.2: `ExHp::RTTI_Base_Class_Descriptor_at_(336)` + the ProcessDamageEvent
/// decompile both pin the embed; the vtable getters read current at this+0x10 and max at
/// this+0x18 as 64-bit ints).
const TARGET_HP_PAIR_OFFSET: usize = 0x150 + 0x10;

/// Read the target's post-hit `(current, max)` HP pair, or `None` when the location isn't
/// readable or the values don't look like a live HP pool.
///
/// The two fields are adjacent 8-byte ints, so ONE 16-byte guard covers both. Two separate
/// `read_ptr_guarded` calls would add two `IsBadReadPtr` probes per hit to a path that runs
/// thousands of times a second on the game's own thread — per-call guard cost on this path
/// is what caused the v1.9.2 in-combat slowdown.
fn read_target_hp_pair(instance: usize) -> Option<(u64, u64)> {
    if instance == 0 {
        return None;
    }
    let addr = instance.wrapping_add(TARGET_HP_PAIR_OFFSET);
    if !readable(addr, 2 * std::mem::size_of::<u64>()) {
        return None;
    }
    let (current, max) = unsafe {
        (
            (addr as *const u64).read_unaligned(),
            ((addr + 8) as *const u64).read_unaligned(),
        )
    };
    sanitize_target_hp(Some(current), Some(max))
}

/// Validate a raw (current, max) HP pair read from the target's ExHp component.
/// Accepts the pair only when it plausibly IS one: both reads succeeded, the pool
/// is initialized (max > 0), current fits inside it, the magnitude is sane, and
/// the pair doesn't sit wholly inside the exe's image band.
///
/// The original 5e9 ceiling sat just under the exe image base (0x140000000 ≈
/// 5.37e9) so ANY pointer would fail it — but hard-mode v2.0.2 bosses sail past
/// it (Lucilius ~7.5e9) and silently lost HP capture entirely. The ceiling now
/// leaves generous headroom; pointer rejection instead targets the two sources
/// directly: heap/ASLR'd-module addresses are all far above the ceiling, and
/// image pointers (vtable/function slots — what a shifted offset would most
/// likely read) are rejected as a pair via the image band below.
fn sanitize_target_hp(current: Option<u64>, max: Option<u64>) -> Option<(u64, u64)> {
    const MAX_PLAUSIBLE_HP: u64 = 100_000_000_000;
    /// granblue_fantasy_relink.exe loads at its preferred base 0x140000000;
    /// pointers into the image land in this band. A real HP pair only overlaps
    /// it while a 5.4e9+ pool is still near full — dropping those few reports
    /// beats letting a vtable-slot pair through as HP.
    const IMAGE_BAND: std::ops::Range<u64> = 0x1_4000_0000..0x1_8000_0000;
    let (current, max) = (current?, max?);
    let looks_like_image_pointers = IMAGE_BAND.contains(&current) && IMAGE_BAND.contains(&max);
    (max > 0 && current <= max && max < MAX_PLAUSIBLE_HP && !looks_like_image_pointers)
        .then_some((current, max))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live log 2026-07-21: EVERY perfect guard fires TWO player-sourced
    /// action-id -1 zero-damage events ~150ms apart — the real counter
    /// (flags 0x40040e0020, carries the stun delta) and a supplementary-echo
    /// companion (flags 0x40040e8020: same but bit 15, 0 delta). Counting
    /// both showed 2 hits per guard, so echo-flagged events never classify.
    #[test]
    fn pg_counter_signature_excludes_the_supp_echo_companion() {
        // The real counter (live-captured flags).
        assert!(is_generic_pg_counter(u32::MAX, 0x40040e0020));
        // Its supp-echo companion (bit 15) must NOT count as a second guard.
        assert!(!is_generic_pg_counter(u32::MAX, 0x40040e8020));
        // Any other action id is not a counter.
        assert!(!is_generic_pg_counter(0, 0x20));
        assert!(!is_generic_pg_counter(1200, 0x40040e0020));
    }

    /// The Quickening marker (live-captured: action 0, flags 0x4000220) only
    /// counts against The World, and — like the generic counter — a supp-echo
    /// companion (bit 15) must never count as a second guard.
    #[test]
    fn quickening_marker_requires_the_world_and_excludes_echoes() {
        assert!(is_quickening_marker(0, 0x4000220, EM8300_THE_WORLD));
        // Same event against any other enemy is not a Quickening guard.
        assert!(!is_quickening_marker(0, 0x4000220, 0x84fdd7b5));
        // Guard bit missing → not a marker.
        assert!(!is_quickening_marker(0, 0x4000200, EM8300_THE_WORLD));
        // A supp echo of the marker must not double-count the guard.
        assert!(!is_quickening_marker(0, 0x4000220 | (1 << 15), EM8300_THE_WORLD));
        assert!(!is_quickening_marker(u32::MAX, 0x4000220, EM8300_THE_WORLD));
    }

    /// Live-confirmed 07-21: Eugen's sticky grenade (applying stun when it sticks
    /// to a target) fires player-sourced zero-damage events with action id 0,
    /// flags 0x6100000 (NO guard bit, not an echo) and a flat ~25 stun. They are
    /// NOT perfect guards — only the generic counter (action -1) is — so they
    /// must classify as their own StunEffect category, not PerfectGuard.
    #[test]
    fn eugen_stun_proc_is_stun_effect_not_perfect_guard() {
        assert_eq!(
            classify_zero_damage_guard(0, 0x6100000, 25.04, 0x2b31654b),
            ZeroDamageGuard::StunEffect
        );
        // Ramped variant (37.56 = 25.04 * 1.5) is the same mechanic.
        assert_eq!(
            classify_zero_damage_guard(0, 0x6100000, 37.56, 0x2b31654b),
            ZeroDamageGuard::StunEffect
        );
    }

    /// A genuine counter (action -1 + guard flag) is a Perfect Guard, and it must
    /// still count when a stun-immune target yields a 0 delta.
    #[test]
    fn real_counter_classifies_as_perfect_guard_even_at_zero_stun() {
        assert_eq!(
            classify_zero_damage_guard(u32::MAX, 0x40040e0020, 250.40, 0x2b31654b),
            ZeroDamageGuard::PerfectGuard
        );
        assert_eq!(
            classify_zero_damage_guard(u32::MAX, 0x40040e0020, 0.0, 0x2b31654b),
            ZeroDamageGuard::PerfectGuard
        );
    }

    /// Live capture 07-22 (online quest, stored log 537): SBA-flagged zero-damage
    /// events also carry action id -1, and they fire ONCE PER FRAME for the whole
    /// duration of an SBA — two bursts of 286 events spanning 4.67s each from a
    /// single player — every one of them carrying no stun. Counting them booked
    /// 700 phantom Perfect Guard hits in one quest (615 on one player), which is
    /// what the guard flag alone could not filter: the largest burst carries it.
    #[test]
    fn per_frame_sba_events_are_not_perfect_guard_counters() {
        // Fediel's SBA, 572 captured events: guard bit SET, but SBA-flagged (13).
        assert!(!is_generic_pg_counter(u32::MAX, 0x4002020));
        // The bit-14 SBA variant (39 captured events).
        assert!(!is_generic_pg_counter(u32::MAX, 0x2044040));
        // ...and the signatures carrying no guard bit at all (141 + 91 captured).
        assert!(!is_generic_pg_counter(u32::MAX, 0x2042040));
        assert!(!is_generic_pg_counter(u32::MAX, 0x2042000));
        // Nothing to emit: no guard, and the SBA ticks carry no stun either.
        assert_eq!(
            classify_zero_damage_guard(u32::MAX, 0x4002020, 0.0, 0x181b3a5b),
            ZeroDamageGuard::None
        );
    }

    /// The guard flag is required, not merely typical: all 173 live-captured real
    /// counters carried bit 5, so an action -1 event without it is some other
    /// mechanic riding the same "no specific action" id.
    #[test]
    fn generic_counter_requires_the_guard_flag() {
        assert!(!is_generic_pg_counter(u32::MAX, 0x40040e0000));
    }

    /// The Quickening marker still wins (checked before the melee-stun fallback),
    /// and events with nothing to emit (echo companion, or a stunless non-guard)
    /// classify as None.
    #[test]
    fn quickening_wins_and_empty_events_emit_nothing() {
        assert_eq!(
            classify_zero_damage_guard(0, 0x4000220, 0.0, EM8300_THE_WORLD),
            ZeroDamageGuard::Quickening
        );
        // Echo companion (bit 15) never classifies, even carrying stun.
        assert_eq!(
            classify_zero_damage_guard(u32::MAX, 0x40040e8020, 250.0, 0x2b31654b),
            ZeroDamageGuard::None
        );
        // A non-guard zero-damage event with no stun has nothing to emit.
        assert_eq!(
            classify_zero_damage_guard(0, 0x6100000, 0.0, 0x2b31654b),
            ZeroDamageGuard::None
        );
    }

    /// The ExHp reads are raw memory on an offset that will silently shift on a
    /// future patch — reject anything that doesn't look like a live HP pair so
    /// garbage can never reach the parser as real HP.
    #[test]
    fn sanitize_target_hp_accepts_only_plausible_pairs() {
        // Ordinary mid-fight value.
        assert_eq!(
            sanitize_target_hp(Some(49_000_000), Some(50_000_000)),
            Some((49_000_000, 50_000_000))
        );
        // Death (current 0) is valid.
        assert_eq!(
            sanitize_target_hp(Some(0), Some(50_000_000)),
            Some((0, 50_000_000))
        );
        // Full HP is valid.
        assert_eq!(sanitize_target_hp(Some(500), Some(500)), Some((500, 500)));
        // Hard-mode v2.0.2 boss scale (Lucilius ~7.5e9) must pass — the old
        // 5e9 ceiling silently dropped HP capture for these fights.
        assert_eq!(
            sanitize_target_hp(Some(7_400_000_000), Some(7_500_000_000)),
            Some((7_400_000_000, 7_500_000_000))
        );
        // A pool whose max lands inside the image band is still accepted once
        // current has fallen below the band — only pointer-LIKE PAIRS reject.
        assert_eq!(
            sanitize_target_hp(Some(5_000_000_000), Some(5_500_000_000)),
            Some((5_000_000_000, 5_500_000_000))
        );

        // A failed guarded read on either side -> None.
        assert_eq!(sanitize_target_hp(None, Some(50_000_000)), None);
        assert_eq!(sanitize_target_hp(Some(49_000_000), None), None);
        // Zero max = uninitialized component -> None.
        assert_eq!(sanitize_target_hp(Some(0), Some(0)), None);
        // current > max = not an HP pair -> None.
        assert_eq!(sanitize_target_hp(Some(51_000_000), Some(50_000_000)), None);
        // A pair of exe-image pointers (vtable slots at a shifted offset) -> None.
        assert_eq!(
            sanitize_target_hp(Some(0x1_4000_0000), Some(0x1_4000_0000)),
            None
        );
        assert_eq!(
            sanitize_target_hp(Some(0x1_4012_3450), Some(0x1_4567_89A0)),
            None
        );
        // Heap / ASLR'd-module addresses -> None (above the ceiling).
        assert_eq!(
            sanitize_target_hp(Some(0x7FF6_0000_0000), Some(0x7FF6_0000_0008)),
            None
        );
    }
}
