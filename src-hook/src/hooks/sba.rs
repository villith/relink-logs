use std::sync::atomic::Ordering;

use anyhow::{anyhow, Result};
use protocol::Message;
use retour::static_detour;

use crate::{event, process::Process};

use super::{actor_idx, actor_type_id, globals::SBA_OFFSET};

// v2.0.2, decompiler-verified (FUN_140bb8840): the gauge-update function takes ELEVEN
// arguments — rcx=SBA component*, xmm1=f32 gauge delta, r8d=u32, r9b=u8, then seven stack
// args: u8, f32, u8, u8, u8, u8, u8. All of them are genuinely read in the body (param_6
// is a float added into the gauge math; params 7-11 gate branches). The old 6-arg
// declaration truncated param_6 (f32) to u8 and never marshalled params 7-11, so re-calling
// the original corrupted the in-game gauge (it went negative). We pass all eleven through.
type OnSBAUpdateFunc = unsafe extern "system" fn(
    *const usize,
    f32,
    u32,
    u8,
    u8,
    f32,
    u8,
    u8,
    u8,
    u8,
    u8,
) -> usize;
type OnSBAAttemptFunc = unsafe extern "system" fn(*const usize, f32) -> usize;
type OnCheckSBACollisionFunc = unsafe extern "system" fn(*const usize, f32) -> usize;
type OnContinueSBAChainFunc = unsafe extern "system" fn(*const usize, *const usize) -> usize;
type OnRemoteSBAUpdateFunc =
    unsafe extern "system" fn(*const usize, *const usize, f32, f32) -> usize;

static_detour! {
    static OnSBAUpdate: unsafe extern "system" fn(*const usize, f32, u32, u8, u8, f32, u8, u8, u8, u8, u8) -> usize;
    static OnSBAAttempt: unsafe extern "system" fn(*const usize, f32) -> usize;
    static OnCheckSBACollision: unsafe extern "system" fn(*const usize, f32) -> usize;
    static OnContinueSBAChain: unsafe extern "system" fn(*const usize, *const usize) -> usize;
    static OnRemoteSBAUpdate: unsafe extern "system" fn(*const usize, *const usize, f32, f32) -> usize;
}

// v2.0.2: call-follow sig at the unique gauge-update call site, resolving to the clean
// entry 0xbb8840 (sigscan: 1 match). Arity fixed to the decompiler-verified 11 args (see
// OnSBAUpdateFunc above) — the previous 6-arg declaration corrupted the in-game gauge.
const ON_HANDLE_SBA_UPDATE_SIG: &str = "48 89 f1 c5 f8 28 ce 41 89 d8 e8 $ { ' } c4 c1 78 2e f8";

// ---------------------------------------------------------------------------
// v2.0.2 slot-poll path (remote SBA recovery, derived 2026-07-17)
//
// The remote-SBA-update hook's signature AND the SBA_OFFSET global both died in
// 2.0.2 (log: "Could not find on_remote_sba_update" / "Could not find sba
// offset"), so remote players' gauges are invisible in online lobbies. Instead
// of chasing the network handler, replicate how the game's own party-wide SBA
// appliers (FUN_141b0dd80 / FUN_1431f1f40, xrefs of the verified gauge-update
// entry 0xbb8840) reach EVERY party member's gauge:
//
//   handle_i  = DAT_147036{7f0,808,820,838}      (4 party-slot entity handles,
//               0x18 stride: {u32 index+1, pad, entity*, u64 id})
//   validate    against the entity table DAT_1470214e8 (+0x20 entity array,
//               +0x48 id array, both indexed by index-1)   [FUN_1406d2490]
//   specified = *(entity + 0x70)
//   component = std-map-find(specified + 0xC0, type_id)    [FUN_140936870]
//               where type_id = DAT_147ab3f50 (runtime static-init counter;
//               its _Init_thread guard at +0x54 reads -1 once initialized)
//   gauge     = *(f32*)(component + 0x7C)   (same field the local update hook
//               reads; component+0x10 = specified instance backref)
//
// All of it is plain data walking — replicated below with guarded reads, no
// game code called. SBAPOLL probe first; production events once live-verified.
// ---------------------------------------------------------------------------
const SBA_SLOT_HANDLES_RVA: usize = 0x70367f0;
const SBA_SLOT_HANDLE_STRIDE: usize = 0x18;
const ENTITY_TABLE_RVA: usize = 0x70214e8;
const SBA_COMPONENT_TYPE_RVA: usize = 0x7ab3f50;
/// Session-mode global: `DAT_147c54810` is a pointer; the game's own online checks
/// read `*(int*)(ptr + 4) == 3` (seen in FUN_143029580 and the result-screen router
/// decompiles). Logged per poll to mark the online→offline transition an AFK
/// conversion causes — the embedded records do NOT flip (2026-07-18 run: allies
/// still read `online=1` during the offline tail), so this global is the candidate
/// production signal for "currently an online lobby".
#[cfg(feature = "hookdiag")]
const SESSION_MODE_PTR_RVA: usize = 0x7c54810;
const ON_ATTEMPT_SBA_SIG: &str = "e8 $ { ' } 48 8d 8e ? ? ff ff c7 44 24 38 00 00 80 3f";
const ON_CHECK_SBA_COLLISION_SIG: &str = "e8 $ { ' } 84 c0 0f 85 f0 00 00 ? 8b 8e ? ? ff ff";
const ON_CONTINUE_SBA_CHAIN_SIG: &str = "e8 $ { ' } 48 8b 53 ? 48 8d 82 ? ? ? ?";
const ON_HANDLE_REMOTE_SBA_UPDATE_SIG: &str =
    "48 8b 8f ? ? ? ? 4c 89 e2 e8 $ { ' } e9 ? ? ? ? 48 81 c7 ? ? ? ? 48 89 f9";

/// MSVC `std::map<u32, ptr>` find, replicating the game's component-by-type
/// lookup FUN_140936870 (main tree only; the fallback tree behind the spinlock
/// is skipped — a miss is just a skipped poll tick). Node layout: left @ +0x00,
/// right @ +0x10, is_nil @ +0x19, key @ +0x20, value @ +0x28; head node at
/// map+0x10, root at head+0x08. Guarded reads, bounded depth.
fn game_stdmap_find(map: usize, key: u32) -> Option<usize> {
    use crate::hooks::diag::{read_ptr_guarded, read_u32_guarded};

    let head = read_ptr_guarded(map, 0x10)?;
    let mut node = read_ptr_guarded(head, 0x08)?;
    let mut best = head;
    for _ in 0..64 {
        // is_nil byte at +0x19 (read via the u32 at +0x18)
        if (read_u32_guarded(node, 0x18) >> 8) & 0xFF != 0 {
            break;
        }
        if key <= read_u32_guarded(node, 0x20) {
            best = node;
            node = read_ptr_guarded(node, 0x00)?;
        } else {
            node = read_ptr_guarded(node, 0x10)?;
        }
    }
    if best != head && read_u32_guarded(best, 0x20) <= key {
        read_ptr_guarded(best, 0x28).filter(|v| *v != 0)
    } else {
        None
    }
}

/// Reads the poll preconditions shared by the diag probe and the production
/// poll: module base, validated component-type id, and the entity table.
///
/// The component-type id is assigned by a C++ static-init counter at
/// runtime. Ghidra (FUN_1406d2490 decompile, 2026-07-18): the guard dword at
/// +0x54 follows the MSVC _Init_thread protocol — 0 = never initialized,
/// -1 = initialization IN PROGRESS, and on completion _Init_thread_footer
/// stamps it with the global init epoch (which STARTS at 0x80000000, so an
/// initialized guard reads 0x8000xxxx, e.g. the live-observed 0x800016e8).
/// The old `guard == -1` test was exactly backwards and made every poll bail.
#[cfg_attr(not(feature = "hookdiag"), allow(unused_variables))]
fn poll_context(log_failures: bool) -> Option<(usize, usize, u32)> {
    use crate::hooks::diag::{read_ptr_guarded, read_u32_guarded, MODULE_BASE};

    let base = MODULE_BASE.load(std::sync::atomic::Ordering::Relaxed);
    if base == 0 {
        return None;
    }
    let type_guard = read_u32_guarded(base, SBA_COMPONENT_TYPE_RVA + 4);
    if type_guard == 0 || type_guard == 0xFFFF_FFFF {
        #[cfg(feature = "hookdiag")]
        if log_failures {
            log::info!("SBAPOLL type-id not initialized (guard={type_guard:#x})");
        }
        return None;
    }
    let type_id = read_u32_guarded(base, SBA_COMPONENT_TYPE_RVA);
    let entity_table = read_ptr_guarded(base, ENTITY_TABLE_RVA)?;
    Some((base, entity_table, type_id))
}

/// Resolves one party slot's handle to its member's SBA component (the single
/// slot walk shared by the diag probe and the production poll — these offsets
/// break on game patches and MUST stay one implementation): read the
/// slot-handle, validate it against the entity table like FUN_1406d2490 does,
/// deref the entity's specified-actor (+0x70), then find the SBA component in
/// its component map (+0xC0). Returns `(entity, id, specified, component)`.
/// Every read is SEH-guarded; any failed step resolves the slot to `None`.
#[cfg_attr(not(feature = "hookdiag"), allow(unused_variables))]
fn resolve_slot_component(
    base: usize,
    entity_table: usize,
    type_id: u32,
    slot: usize,
    log_failures: bool,
) -> Option<(usize, usize, usize, usize)> {
    use crate::hooks::diag::{read_ptr_guarded, read_u32_guarded};

    let handle = base + SBA_SLOT_HANDLES_RVA + slot * SBA_SLOT_HANDLE_STRIDE;
    let index_plus_1 = read_u32_guarded(handle, 0x00);
    if index_plus_1 == 0 {
        return None;
    }
    let entity = read_ptr_guarded(handle, 0x08)?;
    let id = read_ptr_guarded(handle, 0x10).unwrap_or(0);

    // Validate the handle against the entity table like FUN_1406d2490 does.
    let idx = (index_plus_1 - 1) as usize;
    let ids = read_ptr_guarded(entity_table, 0x48).unwrap_or(0);
    let ents = read_ptr_guarded(entity_table, 0x20).unwrap_or(0);
    let id_ok = ids != 0 && read_ptr_guarded(ids, idx * 8) == Some(id);
    let ent_ok = ents != 0 && read_ptr_guarded(ents, idx * 8) == Some(entity);
    if !id_ok || !ent_ok || entity == 0 {
        #[cfg(feature = "hookdiag")]
        if log_failures {
            log::info!(
                "SBAPOLL slot={slot} stale handle (idx={index_plus_1} id_ok={id_ok} ent_ok={ent_ok})"
            );
        }
        return None;
    }

    let specified = read_ptr_guarded(entity, 0x70).filter(|p| *p != 0)?;
    let Some(component) = game_stdmap_find(specified + 0xC0, type_id) else {
        #[cfg(feature = "hookdiag")]
        if log_failures {
            log::info!("SBAPOLL slot={slot} specified={specified:#x} component MISS (type_id={type_id:#x})");
        }
        return None;
    };
    Some((entity, id, specified, component))
}

/// hookdiag: poll all four party slots' SBA gauges via the slot-handle table
/// (see the module comment above) and log one `SBAPOLL` line per resolvable
/// slot, including the actor's embedded-record identity so gauge values are
/// attributable per player even when two players run the same character.
/// Called from the (working, local) gauge-update hook — rate-limited.
#[cfg(feature = "hookdiag")]
fn log_sba_slot_poll() {
    use crate::hooks::diag::{read_f32_guarded, read_ptr_guarded, read_u32_guarded};
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

    static CALLS: AtomicU32 = AtomicU32::new(0);
    let call = CALLS.fetch_add(1, AtomicOrdering::Relaxed);
    if call >= 8 && call % 64 != 0 {
        return;
    }

    let Some((base, entity_table, type_id)) = poll_context(true) else {
        return;
    };

    for slot in 0..4usize {
        let Some((entity, id, specified, component)) =
            resolve_slot_component(base, entity_table, type_id, slot, true)
        else {
            continue;
        };
        let gauge = read_f32_guarded(component, 0x7C).unwrap_or(f32::NAN);
        let backref = read_ptr_guarded(component, 0x10).unwrap_or(0);
        let idx170 = read_u32_guarded(specified, 0x170);
        // Session mode (see SESSION_MODE_PTR_RVA): 3 = online per the game's own
        // checks; expect it to CHANGE when an AFK conversion drops the lobby offline.
        let session_mode = read_ptr_guarded(base, SESSION_MODE_PTR_RVA)
            .map(|p| read_u32_guarded(p, 4) as i64)
            .unwrap_or(-1);
        let (party, online, name) = match super::player::actor_embedded_identity(specified) {
            Some((party, online, name)) => (party as i32, online as i32, name),
            None => (-1, -1, "<unresolved>".to_string()),
        };
        log::info!(
            "SBAPOLL t={} slot={slot} entity={entity:#x} specified={specified:#x} comp={component:#x} \
             backref={backref:#x} id={id:#x} gauge={gauge:.1} idx170={idx170:#x} mode={session_mode} \
             party={party} online={online} name={name}",
            crate::hooks::diag::ms(),
        );
    }
}

/// Last emitted gauge per party slot, so the per-tick poll only emits real
/// changes (keeps event volume sane at the gauge hook's firing rate). -1.0 =
/// never seen, so the first resolvable poll emits the current value.
static LAST_SLOT_GAUGE: std::sync::Mutex<[f32; 4]> = std::sync::Mutex::new([-1.0; 4]);

/// PRODUCTION remote-SBA recovery (Ghidra-derived 2026-07-17/18, live-verified
/// via the SBAPOLL probe on an online lobby): walk the game's own four
/// party-slot entity handles to each member's SBA component and emit slot-keyed
/// gauge events. This replaces the per-entity emission of the (local-only)
/// gauge-update hook — online, that hook fires only for the local player, while
/// this poll reads every member's (synced) gauge. Slot-keyed so the parser's
/// party rows join damage, SBA and stun on the same per-player index.
///
/// Every read is SEH-guarded; a failed step just skips that slot this tick.
fn poll_slots_and_emit(tx: &event::Tx) {
    use crate::hooks::diag::read_f32_guarded;

    let Some((base, entity_table, type_id)) = poll_context(false) else {
        return;
    };
    // try_lock: the gauge hook can fire from the game thread only, but never
    // risk blocking it on a poisoned/contended lock.
    let Ok(mut last) = LAST_SLOT_GAUGE.try_lock() else {
        return;
    };

    for slot in 0..4usize {
        let Some((_entity, _id, _specified, component)) =
            resolve_slot_component(base, entity_table, type_id, slot, false)
        else {
            continue;
        };
        let Some(gauge) = read_f32_guarded(component, 0x7C).filter(|g| g.is_finite()) else {
            continue;
        };

        let previous = last[slot];
        if previous >= 0.0 && (gauge - previous).abs() < 0.05 {
            continue;
        }
        last[slot] = gauge;

        let actor_index = super::player::slot_key(slot as u8);
        if gauge == 0.0 && previous > 0.0 {
            let _ = tx.send(Message::OnPerformSBA(protocol::OnPerformSBAEvent {
                actor_index,
            }));
        }
        let _ = tx.send(Message::OnUpdateSBA(protocol::OnUpdateSBAEvent {
            actor_index,
            sba_value: gauge,
            sba_added: (gauge - previous.max(0.0)).max(0.0),
        }));
    }
}

/// Gets called when your SBA gauge value needs to update with a given value.
#[derive(Clone)]
pub struct OnHandleSBAUpdateHook {
    tx: event::Tx,
}

impl OnHandleSBAUpdateHook {
    pub fn new(tx: event::Tx) -> Self {
        OnHandleSBAUpdateHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(on_sba_update_original) = process.search_address(ON_HANDLE_SBA_UPDATE_SIG) {
            #[cfg(feature = "console")]
            println!("found on sba update");

            let cloned_self = self.clone();

            unsafe {
                let func: OnSBAUpdateFunc = std::mem::transmute(on_sba_update_original);
                OnSBAUpdate.initialize(func, move |a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11| {
                    cloned_self.run(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11)
                })?;
                OnSBAUpdate.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_sba_update"));
        }

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        a1: *const usize,
        a2: f32,
        a3: u32,
        a4: u8,
        a5: u8,
        a6: f32,
        a7: u8,
        a8: u8,
        a9: u8,
        a10: u8,
        a11: u8,
    ) -> usize {
        // Online-recovery probes: whose gauge is this local update for (SBAUPD),
        // and what do all four slot gauges read right now (SBAPOLL)?
        #[cfg(feature = "hookdiag")]
        {
            use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
            static UPD: AtomicU32 = AtomicU32::new(0);
            let n = UPD.fetch_add(1, AtomicOrdering::Relaxed);
            if n < 12 || n % 256 == 0 {
                // v2.0.2: [a1+0x10] is the actor's specified-instance pointer
                // (decompiler-verified vtable object).
                let entity_ptr = unsafe { a1.byte_add(0x10).read() } as *const usize;
                let source_type_id = actor_type_id(entity_ptr);
                let (party, online, name) =
                    match super::player::actor_embedded_identity(entity_ptr as usize) {
                        Some((party, online, name)) => (party as i32, online as i32, name),
                        None => (-1, -1, "<unresolved>".to_string()),
                    };
                log::info!(
                    "SBAUPD comp={:#x} specified={:#x} type={source_type_id:#010x} party={party} online={online} name={name}",
                    a1 as usize,
                    entity_ptr as usize,
                );
            }
            log_sba_slot_poll();
        }

        let ret = unsafe { OnSBAUpdate.call(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) };

        // Production: after the game applied this (local) gauge update, poll ALL
        // FOUR party slots and emit slot-keyed gauge events. Replaces the old
        // per-entity emission — that only ever covered the local player online,
        // and its actor-idx key merged same-character players.
        poll_slots_and_emit(&self.tx);

        ret
    }
}

/// Called when your first try to attempt your SBA, and sets you into "casting SBA" state.
#[derive(Clone)]
pub struct OnAttemptSBAHook {
    tx: event::Tx,
}

impl OnAttemptSBAHook {
    pub fn new(tx: event::Tx) -> Self {
        OnAttemptSBAHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(on_sba_attempt_original) = process.search_address(ON_ATTEMPT_SBA_SIG) {
            #[cfg(feature = "console")]
            println!("found on sba attempt");

            let cloned_self = self.clone();

            unsafe {
                let func: OnSBAAttemptFunc = std::mem::transmute(on_sba_attempt_original);
                OnSBAAttempt.initialize(func, move |a1, a2| cloned_self.run(a1, a2))?;
                OnSBAAttempt.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_sba_attempt"));
        }

        Ok(())
    }

    fn run(&self, a1: *const usize, a2: f32) -> usize {
        // hookdiag: sba_attempt still resolves on v2.0.2; timestamp + callers let us
        // correlate the in-game SBA button press to the SBA manager code that also drives
        // the (broken) sba_update/collision/continue handlers. The caller RVA is stable, so
        // rate-limit the (relatively expensive) stack walk to the first few presses — same
        // policy as process_damage — while still timestamping every attempt.
        crate::hooks::diag::ev!("sba_attempt", "a2={a2}");
        #[cfg(feature = "hookdiag")]
        {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            if crate::hooks::diag::first_n(&N, 3) {
                crate::hooks::diag::log_callers("sba_attempt");
            }
        }

        let ret = unsafe { OnSBAAttempt.call(a1, a2) };

        let entity_ptr = unsafe { a1.byte_add(0x10).read() } as *const usize;

        let source_idx = actor_idx(entity_ptr);
        let source_type_id = actor_type_id(entity_ptr);
        let (_, source_parent_idx) =
            super::player_keyed_parent(source_type_id, source_idx, entity_ptr);

        #[cfg(feature = "console")]
        println!("on sba attempt: player_index={}", source_parent_idx);

        let payload = Message::OnAttemptSBA(protocol::OnAttemptSBAEvent {
            actor_index: source_parent_idx,
        });

        let _ = self.tx.send(payload);

        ret
    }
}

/// Gets called when you're in "casting SBA state" once per game update interval until your SBA lands on
/// the target (or you miss)
/// ONLY WORKS FOR LOCAL.
#[derive(Clone)]
pub struct OnCheckSBACollisionHook {
    tx: event::Tx,
}

impl OnCheckSBACollisionHook {
    pub fn new(tx: event::Tx) -> Self {
        OnCheckSBACollisionHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(on_check_sba_collision_original) =
            process.search_address(ON_CHECK_SBA_COLLISION_SIG)
        {
            #[cfg(feature = "console")]
            println!("found on check sba collision");

            let cloned_self = self.clone();

            unsafe {
                let func: OnCheckSBACollisionFunc =
                    std::mem::transmute(on_check_sba_collision_original);
                OnCheckSBACollision.initialize(func, move |a1, a2| cloned_self.run(a1, a2))?;
                OnCheckSBACollision.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_check_sba_collision"));
        }

        Ok(())
    }

    fn run(&self, a1: *const usize, a2: f32) -> usize {
        let ret = unsafe { OnCheckSBACollision.call(a1, a2) };

        if ret != 0 {
            let entity_ptr = unsafe { a1.byte_add(0x10).read() } as *const usize;

            let source_idx = actor_idx(entity_ptr);
            let source_type_id = actor_type_id(entity_ptr);
            let (_, source_parent_idx) =
                super::player_keyed_parent(source_type_id, source_idx, entity_ptr);

            #[cfg(feature = "console")]
            println!("on perform sba: player_index={}", source_parent_idx);

            let payload = Message::OnPerformSBA(protocol::OnPerformSBAEvent {
                actor_index: source_parent_idx,
            });

            let _ = self.tx.send(payload);
        }

        ret
    }
}

/// Gets called when you connect your SBA with an active SBA chain (2/3/4)
#[derive(Clone)]
pub struct OnContinueSBAChainHook {
    tx: event::Tx,
}

impl OnContinueSBAChainHook {
    pub fn new(tx: event::Tx) -> Self {
        OnContinueSBAChainHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(on_continue_sba_chain_original) =
            process.search_address(ON_CONTINUE_SBA_CHAIN_SIG)
        {
            #[cfg(feature = "console")]
            println!("found on continue sba chain");

            let cloned_self = self.clone();

            unsafe {
                let func: OnContinueSBAChainFunc =
                    std::mem::transmute(on_continue_sba_chain_original);
                OnContinueSBAChain.initialize(func, move |a1, a2| cloned_self.run(a1, a2))?;
                OnContinueSBAChain.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_continue_sba_chain"));
        }

        Ok(())
    }

    fn run(&self, player_entity: *const usize, a2: *const usize) -> usize {
        #[cfg(feature = "console")]
        println!(
            "on continue sba chain: player_entity={:p}, a2={:p}",
            player_entity, a2
        );

        let ret = unsafe { OnContinueSBAChain.call(player_entity, a2) };

        let source_idx = actor_idx(player_entity);
        let source_type_id = actor_type_id(player_entity);
        let (_, source_parent_idx) =
            super::player_keyed_parent(source_type_id, source_idx, player_entity);

        let payload = Message::OnContinueSBAChain(protocol::OnContinueSBAChainEvent {
            actor_index: source_parent_idx,
        });

        let _ = self.tx.send(payload);

        ret
    }
}

#[derive(Clone)]
pub struct OnRemoteSBAUpdateHook {
    tx: event::Tx,
}

impl OnRemoteSBAUpdateHook {
    pub fn new(tx: event::Tx) -> Self {
        OnRemoteSBAUpdateHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        if let Ok(on_remote_sba_update_original) =
            process.search_address(ON_HANDLE_REMOTE_SBA_UPDATE_SIG)
        {
            #[cfg(feature = "console")]
            println!("found on remote sba update");

            let cloned_self = self.clone();

            unsafe {
                let func: OnRemoteSBAUpdateFunc =
                    std::mem::transmute(on_remote_sba_update_original);
                OnRemoteSBAUpdate
                    .initialize(func, move |a1, a2, a3, a4| cloned_self.run(a1, a2, a3, a4))?;
                OnRemoteSBAUpdate.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_remote_sba_update"));
        }

        Ok(())
    }

    fn run(&self, player_entity: *const usize, a2: *const usize, a3: f32, a4: f32) -> usize {
        let sba_offset = SBA_OFFSET.load(Ordering::Relaxed);

        // If the sba_offset signature failed to resolve (setup_globals now logs-and-continues
        // rather than aborting, leaving SBA_OFFSET at 0), reading the gauge at
        // player_entity+0+0x7C yields a garbage f32 and would emit bogus OnUpdateSBA/
        // OnPerformSBA events (e.g. a spurious "performed SBA" when the read happens to be 0.0).
        // Still call the original so game behaviour is unaffected, but skip our observation.
        if sba_offset == 0 {
            return unsafe { OnRemoteSBAUpdate.call(player_entity, a2, a3, a4) };
        }

        let sba_value_ptr =
            unsafe { player_entity.byte_add(sba_offset as usize).byte_add(0x7C) } as *const f32;
        let old_sba_value = unsafe { sba_value_ptr.read() };

        let ret = unsafe { OnRemoteSBAUpdate.call(player_entity, a2, a3, a4) };

        let source_idx = actor_idx(player_entity);
        let source_type_id = actor_type_id(player_entity);
        let (_, source_parent_idx) =
            super::player_keyed_parent(source_type_id, source_idx, player_entity);

        let new_sba_value = unsafe { sba_value_ptr.read() };
        let sba_added = f32::max(new_sba_value - old_sba_value, 0.0);

        // If the SBA value is 0, then the player has performed an SBA and this is resetting their SBA.
        if new_sba_value == 0.0 {
            #[cfg(feature = "console")]
            println!("on perform sba: player_index={}", source_parent_idx);

            let payload = Message::OnPerformSBA(protocol::OnPerformSBAEvent {
                actor_index: source_parent_idx,
            });

            let _ = self.tx.send(payload);
        } else {
            let payload = Message::OnUpdateSBA(protocol::OnUpdateSBAEvent {
                actor_index: source_parent_idx,
                sba_value: new_sba_value,
                sba_added,
            });

            let _ = self.tx.send(payload);
        }

        ret
    }
}
