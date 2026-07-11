use std::ptr::NonNull;

use anyhow::{anyhow, Result};
use protocol::{ActionType, Actor, DamageEvent, Message};
use retour::static_detour;

use crate::{event, hooks::ffi::DamageInstance, process::Process};

use super::{actor_idx, actor_type_id, get_source_parent};

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
        let target_specified_instance_ptr: usize = unsafe { *(*a1.byte_add(0x08) as *const usize) };

        let previous_stun_value = unsafe {
            (target_specified_instance_ptr as *const f32)
                .byte_add(0xA70)
                .read()
        };

        let original_value = unsafe { ProcessDamageEvent.call(a1, a2, a3, a4) };

        let current_stun_value = unsafe {
            (target_specified_instance_ptr as *const f32)
                .byte_add(0xA70)
                .read()
        };
        let added_stun_value = (current_stun_value - previous_stun_value).max(0.0);

        // This points to the first Entity instance in the 'a2' entity list.
        let source_entity_ptr = unsafe { (a2.byte_add(0x18) as *const *const usize).read() };

        // @TODO(false): For some reason, online + Ferry's Umlauf skill pet can return a null pointer here.
        // Possible data race with online?
        if source_entity_ptr.is_null() {
            return original_value;
        }

        // entity->m_pSpecifiedInstance, offset 0x70 from entity pointer.
        // Returns the specific class instance of the source entity. (e.g. Instance of Pl1200 / Pl0700Ghost)
        let source_specified_instance_ptr: usize = unsafe { *(source_entity_ptr.byte_add(0x70)) };

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
                let action_id = unsafe { (a2.byte_add(0x16c) as *const u32).read() };
                let dmg_d0 = unsafe { (a2.byte_add(0xd0) as *const i32).read() };
                let dmg_d4 = unsafe { (a2.byte_add(0xd4) as *const i32).read() };
                let rate_d8 = unsafe { (a2.byte_add(0xd8) as *const f32).read() };
                let rate_dc = unsafe { (a2.byte_add(0xdc) as *const f32).read() };
                let floor = unsafe { (a2.byte_add(0x2b8) as *const i32).read() };
                let cap = unsafe { (a2.byte_add(0x2bc) as *const i32).read() };
                let precap_f32 = unsafe { (a2.byte_add(0x2d4) as *const f32).read() };
                let mut dump = String::new();
                for off in (0xc0usize..0x340).step_by(4) {
                    let v = unsafe { (a2.byte_add(off) as *const u32).read() };
                    if v != 0 {
                        let _ = write!(dump, "[0x{:x}]={} ", off, v);
                    }
                }
                log::info!(
                    "DMGDIAG unk@d0={} dmg@d4={} rate@d8={} rate@dc={} flags@e8={:#x} action@16c={} floor@2b8={} cap@2bc={} precap@2d4={} nonzero: {}",
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

        // If the source_type is any of the following, then we need to get their parent entity.
        let (source_parent_type_id, source_parent_idx) = get_source_parent(
            source_type_id,
            source_specified_instance_ptr as *const usize,
        )
        .unwrap_or((source_type_id, source_idx));

        let target_type_id: u32 = actor_type_id(target_specified_instance_ptr as *const usize);
        let target_idx = actor_idx(target_specified_instance_ptr as *const usize);

        let stun_value = if matches!(action_type, ActionType::SupplementaryDamage(_)) {
            None
        } else {
            Some(added_stun_value)
        };

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
            // v2.0.2: "no cap" now arrives as the 99,999,999 sentinel (the game normalizes
            // a -1 cap to it) rather than 0 — send None for both so cap detection stays off
            // for uncapped hits.
            damage_cap: (damage_instance.damage_cap > 0
                && damage_instance.damage_cap < 99_999_999)
                .then_some(damage_instance.damage_cap),
            stun_value,
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
        if let Ok(process_dot_evt) = process
            .search_address("44 89 74 24 ? 48 8d 54 24 ? 48 8b ce e8 $ { ' } 8b f8 85 c0")
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
            get_source_parent(source_type_id, source).unwrap_or((source_type_id, source_idx));

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
        });

        let _ = self.tx.send(event);

        original_value
    }
}
