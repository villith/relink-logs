use std::ptr::NonNull;

use anyhow::{anyhow, Result};
use protocol::{ActionType, Actor, DamageEvent, Message};
use retour::static_detour;

use crate::{event, hooks::ffi::DamageInstance, process::Process};

use super::{actor_idx, actor_type_id};

type ProcessDamageEventFunc =
    unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;

// v2.0.2: the real process_dot entry (0x477cdb0) reads rcx,rdx,r8,r9 in its prologue
// (`mov rbx,rcx; mov rdi,r9; mov rsi,r8; mov rbp,rdx`) — it is a **4-arg** function, not 2.
// Declaring only 2 left r8/r9 unmarshalled when re-calling the original, risking corrupted
// game state (same class of bug that made sba_update write a negative gauge). We declare all
// four and pass them straight through; we still only read a1/a2 for our own event.
type ProcessDotEventFunc =
    unsafe extern "system" fn(*const usize, *const usize, *const usize, *const usize) -> usize;

static_detour! {
    static ProcessDamageEvent: unsafe extern "system" fn(*const usize, *const usize, *const usize, u8) -> usize;
    static ProcessDotEvent: unsafe extern "system" fn(*const usize, *const usize, *const usize, *const usize) -> usize;
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

#[derive(Clone)]
pub struct OnProcessDamageHook {
    tx: event::Tx,
}

const PROCESS_DAMAGE_EVENT_SIG: &str = "e8 $ { ' } 66 83 bc 24 ? ? ? ? ?";

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

        Ok(())
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

        // v2.0.2: the stun accumulator moved target+0xA70 -> +0xB90. Live-derived via
        // the stun_scan probe (2026-07-15, three targets across three sessions): +0xB90
        // is strictly monotonic across hits with old-scale increments (repeated attacks
        // add identical amounts, e.g. +12.72 per hit), while the old 0xA70 deltas 0.0
        // on every hit. Nearby look-alikes rejected: +0xB3C refreshes to a 2.50 cap and
        // decays (flinch timer), +0xA44 moves <0.01/hit.
        const STUN_ACCUMULATOR_OFFSET: usize = 0xB90;

        let previous_stun_value =
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET);

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
                crate::hooks::diag::snapshot_f32_window(target_specified_instance_ptr, 0x000, 0x1800)
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

        // Stun is a delta across the original call; if either read is unavailable we simply
        // report no stun rather than faulting.
        let added_stun_value = match (
            previous_stun_value,
            read_f32_guarded(target_specified_instance_ptr, STUN_ACCUMULATOR_OFFSET),
        ) {
            (Some(prev), Some(cur)) => (cur - prev).max(0.0),
            _ => 0.0,
        };

        // This points to the first Entity instance in the 'a2' entity list.
        let source_entity_ptr = match read_ptr_guarded(a2 as usize, 0x18) {
            Some(ptr) => ptr as *const usize,
            None => return original_value,
        };

        // @TODO(false): For some reason, online + Ferry's Umlauf skill pet can return a null pointer here.
        // Possible data race with online?
        if source_entity_ptr.is_null() {
            return original_value;
        }

        // entity->m_pSpecifiedInstance, offset 0x70 from entity pointer.
        // Returns the specific class instance of the source entity. (e.g. Instance of Pl1200 / Pl0700Ghost)
        let source_specified_instance_ptr = match read_ptr_guarded(source_entity_ptr as usize, 0x70)
        {
            Some(ptr) if ptr != 0 => ptr,
            _ => return original_value,
        };

        // hookdiag: DISABLED — the wide instance scan was too heavy for the game thread and
        // froze the game. We already captured the structure (see memory). Left here (commented)
        // as the re-enable point for a NARROW, targeted probe if needed.
        // #[cfg(feature = "hookdiag")]
        // crate::hooks::diag::probe_player_instance(source_specified_instance_ptr);

        let damage_instance = unsafe { NonNull::new(a2 as *mut DamageInstance).unwrap().as_ref() };
        let damage: i32 = damage_instance.damage;

        if original_value == 0 || damage <= 0 {
            return original_value;
        }

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
                let (src_type, src_idx) = match read_ptr_guarded(a2 as usize, 0x18)
                    .filter(|p| *p != 0)
                    .and_then(|e| read_ptr_guarded(e, 0x70))
                    .filter(|p| *p != 0)
                {
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

        let action_type: ActionType = if ((1 << 7 | 1 << 50) & flags) != 0 {
            ActionType::LinkAttack
        } else if ((1 << 13 | 1 << 14) & flags) != 0 {
            ActionType::SBA
        } else if ((1 << 15) & flags) != 0 {
            ActionType::SupplementaryDamage(damage_instance.action_id)
        } else {
            ActionType::Normal(damage_instance.action_id)
        };

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

        #[cfg(feature = "hookdiag")]
        if source_type_id == 0xF5755C0E {
            crate::hooks::diag::probe_pl2000_parent(source_specified_instance_ptr);
        }

        // Resolve pets/avatars to their owner, then key players by their embedded
        // record's party slot (v2.0.2: the raw index is character-scoped and merges
        // two players on the same character into one meter row).
        let (source_parent_type_id, source_parent_idx) = super::player_keyed_parent(
            source_type_id,
            source_idx,
            source_specified_instance_ptr as *const usize,
        );

        let target_type_id: u32 = actor_type_id(target_specified_instance_ptr as *const usize);
        let target_idx = actor_idx(target_specified_instance_ptr as *const usize);

        let stun_value = if matches!(action_type, ActionType::SupplementaryDamage(_)) {
            None
        } else {
            Some(added_stun_value)
        };

        // Supplementary damage is never subject to the damage cap; the cap value on
        // its instance belongs to the hit that TRIGGERED it. Send no cap so it can
        // never count as a capped hit. (The parser enforces the same rule for events
        // already recorded in old logs.)
        let damage_cap = if matches!(action_type, ActionType::SupplementaryDamage(_)) {
            None
        } else {
            // v2.0.2: "no cap" now arrives as the 99,999,999 sentinel (the game normalizes
            // a -1 cap to it) rather than 0 — send None for both so cap detection stays off
            // for uncapped hits.
            (damage_instance.damage_cap > 0 && damage_instance.damage_cap < 99_999_999)
                .then_some(damage_instance.damage_cap)
        };

        // Pre-cap base damage (game's DamageInstance +0x2D4). Only meaningful alongside a
        // real cap, so send it only for cappable hits — the parser uses base > cap for exact
        // cap detection and (base/cap)*100 for the game's overcap %. Guard against garbage
        // (NaN/inf/negative) so a shifted offset after a future patch can't poison the parser.
        let base_damage = damage_cap.and_then(|_| {
            let b = damage_instance.base_damage;
            (b.is_finite() && b > 0.0).then_some(b)
        });

        let event = Message::DamageEvent(DamageEvent {
            source: Actor {
                index: source_idx,
                actor_type: source_type_id,
                parent_index: source_parent_idx,
                parent_actor_type: source_parent_type_id,
            },
            target: Actor {
                index: target_idx,
                actor_type: target_type_id,
                parent_index: target_idx,
                parent_actor_type: target_type_id,
            },
            damage,
            flags,
            action_id: action_type,
            attack_rate: Some(damage_instance.attack_rate),
            damage_cap,
            stun_value,
            base_damage,
        });

        let _ = self.tx.send(event);

        original_value
    }
}

#[derive(Clone)]
pub struct OnProcessDotHook {
    tx: event::Tx,
}

impl OnProcessDotHook {
    pub fn new(tx: event::Tx) -> Self {
        OnProcessDotHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        // v2.0.2: the old sig's post-call byte (`4c`) changed to `8b f8` (mov edi,eax);
        // re-anchored on the surviving caller context. Resolves to entry 0x477cdb0
        // (verified a clean 2-arg function entry via Ghidra).
        if let Ok(process_dot_evt) =
            process.search_address("44 89 74 24 ? 48 8d 54 24 ? 48 8b ce e8 $ { ' } 8b f8 85 c0")
        {
            #[cfg(feature = "console")]
            println!("Found process dot event");

            unsafe {
                let func: ProcessDotEventFunc = std::mem::transmute(process_dot_evt);
                ProcessDotEvent
                    .initialize(func, move |a1, a2, a3, a4| cloned_self.run(a1, a2, a3, a4))?;
                ProcessDotEvent.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find process_dot_evt"));
        }

        Ok(())
    }

    // A1: DoT Instance (StatusPl2300ParalysisArrow)
    // *A1+0x00 -> StatusAilmentPoison : StatusBase
    // A1+0x18->targetEntityInfo : CEntityInfo (Target entity of the DoT, what is being damaged)
    // A1+0x30->sourceEntityInfo : CEntityInfo (Source entity of the DoT, who applied it)
    // A1+0x50->duration : float (How much time is left for the DoT)
    fn run(
        &self,
        dot_instance: *const usize,
        a2: *const usize,
        a3: *const usize,
        a4: *const usize,
    ) -> usize {
        // Pass ALL FOUR args through unchanged so the game's own DoT code runs with its real
        // arguments (a3=r8, a4=r9 were previously dropped → garbage r8/r9 in the callee).
        let original_value = unsafe { ProcessDotEvent.call(dot_instance, a2, a3, a4) };

        // @TODO(false): There's a better way to check null pointers with Option type, but I'm too dumb to figure it out right now.
        let target_info = unsafe { dot_instance.byte_add(0x18).read() } as *const usize;
        let source_info = unsafe { dot_instance.byte_add(0x30).read() } as *const usize;

        if target_info.is_null() || source_info.is_null() {
            return original_value;
        }

        let target = unsafe { target_info.byte_add(0x70).read() } as *const usize;
        let source = unsafe { source_info.byte_add(0x70).read() } as *const usize;

        if target.is_null() || source.is_null() {
            return original_value;
        }

        let dmg = unsafe { (a2 as *const i32).read() };

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
                index: target_idx,
                actor_type: target_type_id,
                parent_index: target_idx,
                parent_actor_type: target_type_id,
            },
            damage: dmg,
            flags: 0,
            action_id: ActionType::DamageOverTime(0),
            attack_rate: None,
            stun_value: None,
            damage_cap: None,
            base_damage: None,
        });

        let _ = self.tx.send(event);

        original_value
    }
}
