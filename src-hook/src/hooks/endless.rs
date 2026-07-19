//! Conflux / EndlessMode hooks.
//!
//! The v2.0.2 "Conflux" roguelike mode is internally codenamed **EndlessMode**
//! (`stage::quest::EndlessModeQuestManager` / `ReceptionEndlessModeFlow`,
//! `ExPlayerEndlessModeBuff`). "Conflux" is a UI/localization string only — it appears
//! nowhere in the exe. See the memory note `gbfr-conflux-endless-mode` for the full map.
//!
//! These detours emit real `protocol::Message`s so the parser can group a run's rooms and
//! per-room buffs (see the `gbfr-conflux-ui-feature` note + spec). The room-boundary signal
//! itself comes from the `on_load_quest_state` hook (quest.rs), not from here — this file
//! provides run-START (reception dispatcher → EndlessMode flow), buff-acquired, and run-END
//! (manager destructor). The `#[cfg(feature = "hookdiag")]` blocks keep the original
//! field-window diagnostics for re-deriving offsets on future patches.
//!
//! Targets (v2.0.2 RVAs, Ghidra-verified clean function entries — see sigs below):
//!   * `FUN_140638690` @ 0x638690 — the quest-reception-flow dispatcher. Given the
//!     stage-quest manager (rcx) and a packed quest-type word (edx), it builds the right
//!     reception flow by `(edx >> 0x14) & 0xf`: **type 8 = ReceptionEndlessModeFlow**
//!     (a Conflux run being set up), type 3 = Fate Episode, etc. 2-arg entry.
//!   * `FUN_14277bc60` @ 0x277bc60 — `ExPlayerEndlessModeBuff::onInstall`, a genuine
//!     per-class virtual method (vtable slot 5). Fires when the endless-mode buff
//!     component is installed on a player actor; it registers ~20 ability slots at
//!     +0xc0, +0x140, +0x1c0, … (stride 0x80). 1-arg entry (rcx = buff `this`).
//!   * `FUN_14060d7b0` @ 0x60d7b0 — `EndlessModeQuestManager` destructor, freed once at
//!     run end. 1-arg entry (rcx = manager). The unambiguous run-END signal.

use anyhow::{anyhow, Result};
use retour::static_detour;

use crate::event;
use crate::process::Process;

// v2.0.2 direct-entry signatures (sigscan-verified: 1 match each, cursor at the entry).
// Both anchor on the preceding function's `ret` + int3 padding, then the target prologue.
//   dispatcher: c3 cc cc | 55 56 57 53 48 83 ec 38 ...  (0x638690)
//   onInstall:  c3 cc cc cc | 56 57 48 83 ec 68 48 89 ce ...  (0x277bc60)
const ON_RECEPTION_FLOW_DISPATCH_SIG: &str =
    "c3 cc cc ' 55 56 57 53 48 83 ec 38 48 8d 6c 24 30 48 c7 45 00 fe ff ff ff 48 89 ce c1 ea 14";
const ON_ENDLESS_BUFF_INSTALL_SIG: &str =
    "c3 cc cc cc ' 56 57 48 83 ec 68 48 89 ce 48 8d 91 c0 00 00 00 48 8d 05";
// EndlessModeQuestManager destructor FUN_14060d7b0 (0x60d7b0), a clean 1-arg entry
// `fn(rcx=manager)`. The manager is created at run start and freed ONCE at run end (its
// base stayed stable across all rooms in a run — only the per-room reception FLOW churns),
// so this is the unambiguous run-END signal that no reception fires for (the reward
// screen / exit-to-town path doesn't go through the reception dispatcher). Sig anchors on
// the preceding `ret`+int3 padding then the distinctive large-frame prologue; sigscan = 1
// match resolving to 0x60d7b0.
const ON_ENDLESS_MGR_DTOR_SIG: &str =
    "cc cc cc cc ' 55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 78 04 00 00 48 8d ac 24 80 00 00 00 c5 f8 29 bd e0 03 00 00";

/// Quest-type value (decoded `(edx >> 0x14) & 0xf` in the dispatcher) that selects the
/// EndlessMode reception flow — i.e. a Conflux run being set up.
#[cfg(feature = "hookdiag")]
const QUEST_TYPE_ENDLESS_MODE: u32 = 8;

/// Type-hash stamped at reception-flow+0x7c8 that identifies a `ReceptionEndlessModeFlow`.
/// Used to detect the run-START edge (flow slot transitions INTO an EndlessMode flow), and
/// by the quest-load hook (quest.rs) to suppress the between-quest boundary cut on Conflux
/// room loads.
pub(crate) const ENDLESS_FLOW_TYPE: u32 = 0x887ae0b0;

/// Offset of the reception-flow type-hash within a flow object (`puVar5[0xf9]` in the
/// dispatcher: 0xf9*8 = 0x7c8).
pub(crate) const FLOW_TYPE_OFFSET: usize = 0x7c8;

/// Offset of the first ability/buff slot within an `ExPlayerEndlessModeBuff` (slots stride
/// 0x80: +0xc0, +0x140, …). We emit the value at the first slot as the representative buff
/// id; the parser dedups. Adjust here if live testing shows a different stable offset —
/// grouping/meters are unaffected by this one line.
const ENDLESS_BUFF_FIRST_SLOT: usize = 0xc0;

type OnReceptionFlowDispatchFunc = unsafe extern "system" fn(*const usize, u32) -> usize;
type OnEndlessBuffInstallFunc = unsafe extern "system" fn(*const usize) -> usize;
type OnEndlessMgrDtorFunc = unsafe extern "system" fn(*const usize) -> usize;

static_detour! {
    static OnReceptionFlowDispatch: unsafe extern "system" fn(*const usize, u32) -> usize;
    static OnEndlessBuffInstall: unsafe extern "system" fn(*const usize) -> usize;
    static OnEndlessMgrDtor: unsafe extern "system" fn(*const usize) -> usize;
}

/// Detects the start of a Conflux run: emits `ConfluxRunStart` on the reception-flow slot
/// transitioning INTO an EndlessMode flow. Observe-only: both args are passed straight
/// through (a dropped arg crashed the quest hook on v2.0.2 — see quest.rs).
#[derive(Clone)]
pub struct OnReceptionFlowDispatchHook {
    tx: event::Tx,
}

impl OnReceptionFlowDispatchHook {
    pub fn new(tx: event::Tx) -> Self {
        OnReceptionFlowDispatchHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(ON_RECEPTION_FLOW_DISPATCH_SIG) {
            unsafe {
                let func: OnReceptionFlowDispatchFunc = std::mem::transmute(addr);
                OnReceptionFlowDispatch.initialize(func, move |a1, a2| cloned_self.run(a1, a2))?;
                OnReceptionFlowDispatch.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find reception_flow_dispatch"))
        }
    }

    fn run(&self, a1: *const usize, a2: u32) -> usize {
        // The dispatcher REPLACES the reception-flow slot (+0x210); read it BEFORE calling
        // the original so the pre-call pointer is the OUTGOING flow. A run STARTS when the
        // slot goes (null/other) -> EndlessMode-flow.
        // Guarded like every other read here: a layout shift or unexpected `this` must never
        // hard-fault the game thread. `None` (unreadable) maps to 0, which the downstream
        // `read_u32_guarded`/`!= 0` checks already treat as "no flow".
        let flow_before = crate::hooks::diag::read_ptr_guarded(a1 as usize, 0x210).unwrap_or(0);
        let flow_type_before = crate::hooks::diag::read_u32_guarded(flow_before, FLOW_TYPE_OFFSET);

        #[cfg(feature = "hookdiag")]
        {
            let quest_type = (a2 >> 0x14) & 0xf;
            crate::hooks::diag::ev!(
                "endless_reception",
                "raw={a2:#x} quest_type={quest_type} is_endless={} flow_before={flow_before:#x} flow_type_before={flow_type_before:#x}",
                quest_type == QUEST_TYPE_ENDLESS_MODE
            );
            crate::hooks::diag::probe_u32_window_delta("reception_mgr", a1 as usize, 0x800);
            if flow_before != 0 {
                crate::hooks::diag::probe_u32_window_delta("reception_flow", flow_before, 0x820);
            }
        }

        let ret = unsafe { OnReceptionFlowDispatch.call(a1, a2) };

        let flow_after = crate::hooks::diag::read_ptr_guarded(a1 as usize, 0x210).unwrap_or(0);
        let flow_type_after = crate::hooks::diag::read_u32_guarded(flow_after, FLOW_TYPE_OFFSET);

        // The reception dispatcher rebuilds the EndlessMode flow once PER ROOM (the slot at
        // +0x210 resets to null each room), so a transition INTO an EndlessMode flow is a
        // ROOM-ENTER — not a run-start. The parser derives run identity from the manager
        // pointer (`a1`, stable across a run's rooms). quest_id lives at manager+0x1D8+... —
        // read it guarded, 0 if unavailable at this point.
        let is_room_enter =
            flow_type_before != ENDLESS_FLOW_TYPE && flow_type_after == ENDLESS_FLOW_TYPE;

        // QuestState is at manager+0x1D8; its quest_id is the first u32 (see quest.rs). Read
        // guarded so a not-yet-populated state can never fault.
        let quest_id = crate::hooks::diag::read_u32_guarded(a1 as usize, 0x1D8);

        log::warn!(
            "CONFLUX hook: reception_dispatch manager={:#x} type_before={:#x} type_after={:#x} room_enter={} quest_id={:#x}",
            a1 as usize,
            flow_type_before,
            flow_type_after,
            is_room_enter,
            quest_id
        );

        if is_room_enter {
            let _ = self.tx.send(protocol::Message::ConfluxRoomEnter(
                protocol::ConfluxRoomEnterEvent {
                    quest_id,
                    manager_ptr: a1 as u64,
                },
            ));
        }

        #[cfg(feature = "hookdiag")]
        {
            let quest_type = (a2 >> 0x14) & 0xf;
            crate::hooks::diag::ev!(
                "endless_reception_after",
                "quest_type={quest_type} flow_after={flow_after:#x} flow_type_after={flow_type_after:#x} changed={}",
                flow_after != flow_before
            );
        }

        ret
    }
}

/// Emits `ConfluxBuffAcquired` on each `ExPlayerEndlessModeBuff::onInstall`. Observe-only
/// pass-through.
#[derive(Clone)]
pub struct OnEndlessBuffInstallHook {
    tx: event::Tx,
}

impl OnEndlessBuffInstallHook {
    pub fn new(tx: event::Tx) -> Self {
        OnEndlessBuffInstallHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(ON_ENDLESS_BUFF_INSTALL_SIG) {
            unsafe {
                let func: OnEndlessBuffInstallFunc = std::mem::transmute(addr);
                OnEndlessBuffInstall.initialize(func, move |a1| cloned_self.run(a1))?;
                OnEndlessBuffInstall.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find endless_buff_install"))
        }
    }

    fn run(&self, a1: *const usize) -> usize {
        // Read the representative buff id from the first ability slot (guarded, 0 if not yet
        // populated). onInstall may fire repeatedly during RNG init, so the parser dedups;
        // we simply skip a 0 id. THIS is the buff-id offset tuning point (see const doc).
        let buff_id = crate::hooks::diag::read_u32_guarded(a1 as usize, ENDLESS_BUFF_FIRST_SLOT);
        // [CONFLUX-DIAG] proves buff_install fired + shows the id we read at +0xc0.
        log::info!(
            "CONFLUX hook: buff_install this={:#x} buff_id={:#x}",
            a1 as usize,
            buff_id
        );
        if buff_id != 0 {
            let _ = self.tx.send(protocol::Message::ConfluxBuffAcquired(
                protocol::ConfluxBuffAcquiredEvent { buff_id },
            ));
        }

        #[cfg(feature = "hookdiag")]
        {
            crate::hooks::diag::ev!("endless_buff", "buff_this={:#x} buff_id={buff_id:#x}", a1 as usize);
            crate::hooks::diag::probe_u32_window_delta("endless_buff", a1 as usize, 0x1000);
        }

        unsafe { OnEndlessBuffInstall.call(a1) }
    }
}

/// Emits `ConfluxRunEnd` when the `EndlessModeQuestManager` is destroyed — the unambiguous
/// run-END signal (the reward-screen / exit-to-town path fires no reception). Observe-only:
/// the message is sent, then the real destructor runs unchanged.
#[derive(Clone)]
pub struct OnEndlessMgrDtorHook {
    tx: event::Tx,
}

impl OnEndlessMgrDtorHook {
    pub fn new(tx: event::Tx) -> Self {
        OnEndlessMgrDtorHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(addr) = process.search_address(ON_ENDLESS_MGR_DTOR_SIG) {
            unsafe {
                let func: OnEndlessMgrDtorFunc = std::mem::transmute(addr);
                OnEndlessMgrDtor.initialize(func, move |a1| cloned_self.run(a1))?;
                OnEndlessMgrDtor.enable()?;
            }
            Ok(())
        } else {
            Err(anyhow!("Could not find endless_mgr_dtor"))
        }
    }

    fn run(&self, a1: *const usize) -> usize {
        log::warn!("CONFLUX hook: mgr_dtor (run-end) manager={:#x}", a1 as usize);
        let _ = self
            .tx
            .send(protocol::Message::ConfluxRunEnd(protocol::ConfluxRunEndEvent {
                manager_ptr: a1 as u64,
            }));

        #[cfg(feature = "hookdiag")]
        {
            crate::hooks::diag::ev!("endless_run_end", "manager={:#x}", a1 as usize);
            crate::hooks::diag::probe_u32_window_delta("reception_mgr", a1 as usize, 0x800);
        }

        unsafe { OnEndlessMgrDtor.call(a1) }
    }
}
