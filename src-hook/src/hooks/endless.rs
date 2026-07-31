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

/// Boss-source hunt (2026-07-28): every identity encoding a drawn Conflux boss could be
/// stored under — packed `0x20000|EM` quest ids and XXHash32Custom actor-type hashes — for
/// all 29 vanilla boss-room bosses plus the 4 swap targets. The reception hook needle-scans
/// the whole `EndlessModeQuestManager` for these each room; wherever the drawn boss's id
/// lives, `ev=needlescan` logs its offset. Hashes are the keys of
/// `src-tauri/lang/en/enemies.json` (XXHash32Custom of "Em####").
#[cfg(feature = "hookdiag")]
const BOSS_NEEDLES: &[(u32, &str)] = &[
    (0x20005, "Em0005"),
    (0x84fdd7b5, "hEm0005"),
    (0x21804, "Em1804"),
    (0x181b3a5b, "hEm1804"),
    (0x21805, "Em1805"),
    (0x0e3d1703, "hEm1805"),
    (0x21800, "Em1800"),
    (0x044bbc73, "hEm1800"),
    (0x20501, "Em0501"),
    (0x5fb90ec9, "hEm0501"),
    (0x20706, "Em0706"),
    (0xb31ee30a, "hEm0706"),
    (0x20103, "Em0103"),
    (0xb69dd953, "hEm0103"),
    (0x27200, "Em7200"),
    (0xc3c58c76, "hEm7200"),
    (0x27300, "Em7300"),
    (0x75a3867c, "hEm7300"),
    (0x21802, "Em1802"),
    (0xe170f036, "hEm1802"),
    (0x21803, "Em1803"),
    (0xafeb2d7e, "hEm1803"),
    (0x21500, "Em1500"),
    (0x3f7f9a35, "hEm1500"),
    (0x20102, "Em0102"),
    (0x3a0ea858, "hEm0102"),
    (0x21501, "Em1501"),
    (0xf38ad679, "hEm1501"),
    (0x27100, "Em7100"),
    (0x8c3adb57, "hEm7100"),
    (0x21801, "Em1801"),
    (0x4a299e62, "hEm1801"),
    (0x20502, "Em0502"),
    (0xba320eeb, "hEm0502"),
    (0x21900, "Em1900"),
    (0x6409b2a8, "hEm1900"),
    (0x22000, "Em2000"),
    (0x17576f75, "hEm2000"),
    (0x22100, "Em2100"),
    (0xe4c12a94, "hEm2100"),
    (0x22200, "Em2200"),
    (0xeab390a0, "hEm2200"),
    (0x21600, "Em1600"),
    (0x7d71c604, "hEm1600"),
    (0x20500, "Em0500"),
    (0xb71014c5, "hEm0500"),
    (0x21700, "Em1700"),
    (0x4a9e6f56, "hEm1700"),
    (0x21806, "Em1806"),
    (0x65c26889, "hEm1806"),
    (0x27600, "Em7600"),
    (0xb4aed02d, "hEm7600"),
    (0x28300, "Em8300"),
    (0xd7ba6d4a, "hEm8300"),
    (0x28200, "Em8200"),
    (0x66a3b7f4, "hEm8200"),
    (0x27700, "Em7700"),
    (0x2b31654b, "hEm7700"),
];

/// How much of the `EndlessModeQuestManager` the boss-needle scan covers. The manager's
/// fields reach out to ~+0x63be0 (Ghidra), so 0x64000 spans the whole object.
#[cfg(feature = "hookdiag")]
const MGR_SCAN_LEN: usize = 0x64000;

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

#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnReceptionFlowDispatch", &OnReceptionFlowDispatch);
    super::disable_quiet("OnEndlessBuffInstall", &OnEndlessBuffInstall);
    super::disable_quiet("OnEndlessMgrDtor", &OnEndlessMgrDtor);
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
            // If the hook was (re)loaded into a session already sitting in an
            // endless room (e.g. tray-reload while stuck at a gate), no new
            // reception will fire — start the appear probe against the active
            // flow directly.
            #[cfg(feature = "hookdiag")]
            appear_probe::start_if_active();
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
            // Everything below is scoped to an EndlessMode reception. The dispatcher fires
            // for EVERY quest type, and on a non-Conflux one `a1` is not an
            // `EndlessModeQuestManager` at all — a 0x64000-wide deep scan of it would be
            // pure waste on the game's own thread, which is where this runs.
            if flow_type_after == ENDLESS_FLOW_TYPE {
                // Boss-source hunt: sweep the whole manager (and the fresh reception flow)
                // for every known boss-identity encoding. The flat inline scan came back
                // EMPTY at a live boss-room reception (847010/Rock Golem), so the deep
                // variant also chases one level of heap pointers — vectors of drawn-room
                // state live off-object. Post-call so the dispatcher has already installed
                // the new room's state.
                crate::hooks::diag::scan_u32_needles_deep(
                    "mgr",
                    a1 as usize,
                    MGR_SCAN_LEN,
                    BOSS_NEEDLES,
                );
                if flow_after != 0 {
                    crate::hooks::diag::scan_u32_needles_deep(
                        "flow",
                        flow_after,
                        0x2000,
                        BOSS_NEEDLES,
                    );
                }
                // Boss-appear graft probe: on each room enter, sample the active flow's
                // appear fields and walk the scene-object uuid map (see appear_probe).
                appear_probe::start(a1 as usize);
            }
        }

        ret
    }
}

/// Probe for the build9 BossAppearAction graft (feature `hookdiag`): after a Conflux room
/// enter, samples at 1 Hz for 150 s the active flow's boss-appear fields —
/// `flow+0x320`/`+0x348` (main/sub boss uuid written by stage::quest::BossAppearAction's
/// execute), `+0x4d0` (appear-point uuid), the byte window around `+0xf1` (appear-pending
/// flag) — and periodically walks the scene-manager's per-scene `unordered_map<u64 uuid,
/// u32 slot>` (the map `FUN_141f7e8f0` resolves boss uuids against), logging every entry
/// plus the mapped actor's type id. Answers, from ONE stuck-room resume: did the appear
/// action execute, does the uuid ever resolve, and under WHICH key the dormant boss actor
/// actually registered. Every read is guarded; all loops bounded; runs on its own thread.
#[cfg(feature = "hookdiag")]
mod appear_probe {
    use std::ops::ControlFlow;
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::hooks::diag;

    static RUNNING: AtomicBool = AtomicBool::new(false);
    /// Consecutive samples with the reception flow parked in state 0xf
    /// (wait-boss-appear-event, `FUN_141fdc370`).
    static STUCK_0XF: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    /// One skip-force per probe run.
    static SKIP_FIRED: AtomicBool = AtomicBool::new(false);

    /// Scene-manager singleton `DAT_147ab3150` (v2.0.2), as an RVA.
    const SCENE_MGR_RVA: usize = 0x7ab3150;
    /// The donor mainBossUUID_ value carried verbatim by every build9 grafted FSM.
    const GRAFT_UUID: u64 = 0x5423_D01D_B25B_63E6;

    /// EndlessModeQuestManager pointer global `DAT_147c54830` (v2.0.2), as an RVA.
    const ENDLESS_MGR_PTR_RVA: usize = 0x7c54830;

    /// Scene-list roots, mirroring `FUN_141f7e8f0`'s addressing: scene manager
    /// `[DAT_147ab3150]`, inner list at `+0x20`, circular-list sentinel at `+0x60`.
    /// `None` when the manager itself is unreadable.
    fn scene_map_roots() -> Option<(usize, usize, usize)> {
        let base = diag::MODULE_BASE.load(Ordering::Relaxed);
        if base == 0 {
            return None;
        }
        let smgr = diag::read_ptr_guarded(base, SCENE_MGR_RVA)?;
        let inner = diag::read_ptr_guarded(smgr, 0x20).unwrap_or(0);
        let sent = if inner != 0 {
            diag::read_ptr_guarded(inner, 0x60).unwrap_or(0)
        } else {
            0
        };
        Some((smgr, inner, sent))
    }

    /// Every scene hanging off `sent`, as `(index, holder, value array)` — the map holder
    /// at `elem+0x30` and its value array at `holder+0xf0`. Bounded to 16 scenes.
    ///
    /// This and [`for_each_scene_node`] hold the RE'd map addressing in ONE place: a game
    /// patch that shifts these offsets is fixed here, rather than in each probe that walks
    /// the list — where the copy left un-updated would silently report an empty map forever.
    fn for_each_scene_map(
        sent: usize,
        mut visit: impl FnMut(usize, usize, usize) -> ControlFlow<()>,
    ) {
        let mut elem = if sent != 0 {
            diag::read_ptr_guarded(sent, 0).unwrap_or(0)
        } else {
            0
        };
        for index in 0..16 {
            if elem == 0 || elem == sent || !diag::readable(elem, 0x100) {
                return;
            }
            let holder = diag::read_ptr_guarded(elem, 0x30).unwrap_or(0);
            if holder != 0 && diag::readable(holder, 0x100) {
                let arr = diag::read_ptr_guarded(holder, 0xf0).unwrap_or(0);
                if visit(index, holder, arr).is_break() {
                    return;
                }
            }
            elem = diag::read_ptr_guarded(elem, 0).unwrap_or(0);
        }
    }

    /// One map's nodes as `(key, slot)` — list end at `holder+0x88`, nodes linked by `next`
    /// at `+0` with the uuid key at `+0x28` and the value-array slot at `+0x30`. Returns how
    /// many nodes were visited; bounded to 1024.
    fn for_each_scene_node(
        holder: usize,
        mut visit: impl FnMut(u64, u32) -> ControlFlow<()>,
    ) -> u32 {
        let end = diag::read_ptr_guarded(holder, 0x88).unwrap_or(0);
        let mut cur = diag::read_ptr_guarded(end, 0).unwrap_or(0);
        let mut n = 0u32;
        while cur != 0 && cur != end && n < 1024 && diag::readable(cur, 0x40) {
            let key = diag::read_u64_guarded(cur, 0x28).unwrap_or(0);
            let slot = diag::read_u32_guarded(cur, 0x30);
            n += 1;
            if visit(key, slot).is_break() {
                break;
            }
            cur = diag::read_ptr_guarded(cur, 0).unwrap_or(0);
        }
        n
    }

    /// The placement object a scene map holds for `uuid`, or 0 if no scene knows it.
    /// Value array slots are 0x10 bytes with the object pointer at slot start
    /// (`FUN_141f7e8f0`: `*(holder+0xf0) + slot * 0x10`).
    fn scene_object_for(uuid: u64) -> usize {
        let Some((_, _, sent)) = scene_map_roots() else {
            return 0;
        };
        let mut obj = 0usize;
        for_each_scene_map(sent, |_, holder, arr| {
            let mut found = ControlFlow::Continue(());
            for_each_scene_node(holder, |key, slot| {
                if key != uuid {
                    return ControlFlow::Continue(());
                }
                if arr != 0 {
                    obj = diag::read_ptr_guarded(arr, (slot as usize) * 0x10).unwrap_or(0);
                }
                found = ControlFlow::Break(());
                ControlFlow::Break(())
            });
            found
        });
        obj
    }

    /// Start the probe against an already-active endless flow — used after a
    /// mid-game hook reload into a stuck room, where no reception will fire.
    pub fn start_if_active() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let base = diag::MODULE_BASE.load(Ordering::Relaxed);
            if base == 0 {
                return;
            }
            let Some(mgr) = diag::read_ptr_guarded(base, ENDLESS_MGR_PTR_RVA) else {
                return;
            };
            if mgr == 0 {
                return;
            }
            let flow = diag::read_ptr_guarded(mgr, 0x210).unwrap_or(0);
            if flow != 0
                && diag::read_u32_guarded(flow, super::FLOW_TYPE_OFFSET) == super::ENDLESS_FLOW_TYPE
            {
                diag::ev!(
                    "appear_probe",
                    "auto-start on load, active flow mgr={mgr:#x}"
                );
                start(mgr);
            }
        });
    }

    pub fn start(mgr: usize) {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        STUCK_0XF.store(0, Ordering::SeqCst);
        SKIP_FIRED.store(false, Ordering::SeqCst);
        std::thread::spawn(move || {
            diag::ev!("appear_probe", "start mgr={mgr:#x}");
            for tick in 0..150u32 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                sample_flow(mgr, tick);
                sample_boss(mgr, tick);
                if tick % 15 == 3 {
                    walk_scene_maps(tick);
                }
            }
            diag::ev!("appear_probe", "end mgr={mgr:#x}");
            RUNNING.store(false, Ordering::SeqCst);
        });
    }

    /// Actor-handle validation tables `DAT_1470214e8` (v2.0.2), as an RVA.
    const ACTOR_TBL_RVA: usize = 0x70214e8;

    /// Resolve the armed boss uuid to its ACTOR exactly like `FUN_141f7e8f0`
    /// (scene map -> placement object -> vfunc slot 0x10 handle -> validation
    /// tables -> actor = *(handle.a + 0x70)), then dump the actor's FSM-event
    /// bookkeeping that the state-0xf wait (`FUN_141fdc370`) polls: pointers at
    /// actor+0x19b8/+0x19c0, the current event hash at *q-0x108, and the event
    /// map at *q-0x78 (nodes: key u32 at +0x20, value ptr at +0x68, status int
    /// at value+0x38 — state 0xf completes when the queue is empty or the
    /// current entry's status == 2).
    fn sample_boss(mgr: usize, tick: u32) {
        let base = diag::MODULE_BASE.load(Ordering::Relaxed);
        if base == 0 {
            return;
        }
        let flow = diag::read_ptr_guarded(mgr, 0x210).unwrap_or(0);
        if flow == 0 {
            return;
        }
        let uuid = diag::read_u64_guarded(flow, 0x320).unwrap_or(0);
        if uuid == 0 {
            return;
        }
        let obj = scene_object_for(uuid);
        if obj == 0 {
            diag::ev!("appear_boss", "t{tick} uuid={uuid:#x} no-map-entry");
            return;
        }
        // handle getter: vfunc slot 0x10 (byte offset 0x80), out = {u32 id; pad; u64 a; u64 b}
        let vt = diag::read_ptr_guarded(obj, 0).unwrap_or(0);
        if vt <= base || vt >= base + 0x9000000 {
            diag::ev!("appear_boss", "t{tick} obj={obj:#x} bad-vtable {vt:#x}");
            return;
        }
        let f = diag::read_ptr_guarded(vt, 0x80).unwrap_or(0);
        if f <= base || f >= base + 0x9000000 {
            diag::ev!("appear_boss", "t{tick} obj={obj:#x} bad-getter {f:#x}");
            return;
        }
        let mut out = [0u8; 0x18];
        unsafe {
            let getter: extern "system" fn(usize, *mut u8) = std::mem::transmute(f);
            getter(obj, out.as_mut_ptr());
        }
        let id = u32::from_le_bytes(out[0..4].try_into().unwrap());
        let a = u64::from_le_bytes(out[8..16].try_into().unwrap()) as usize;
        let b = u64::from_le_bytes(out[16..24].try_into().unwrap());
        let tbl = diag::read_ptr_guarded(base, ACTOR_TBL_RVA).unwrap_or(0);
        let (t20, t48) = if tbl != 0 {
            (
                diag::read_ptr_guarded(tbl, 0x20).unwrap_or(0),
                diag::read_ptr_guarded(tbl, 0x48).unwrap_or(0),
            )
        } else {
            (0, 0)
        };
        let valid = id != 0
            && a != 0
            && t20 != 0
            && t48 != 0
            && diag::read_ptr_guarded(t48, (id as usize - 1) * 8) == Some(b as usize)
            && diag::read_ptr_guarded(t20, (id as usize - 1) * 8) == Some(a);
        let hflags = diag::read_u32_guarded(a, 0x30);
        let actor = if valid {
            diag::read_ptr_guarded(a, 0x70).unwrap_or(0)
        } else {
            0
        };
        if actor == 0 {
            diag::ev!(
                "appear_boss",
                "t{tick} obj={obj:#x} handle id={id} a={a:#x} b={b:#x} valid={valid} hflags={hflags:#x} NO-ACTOR"
            );
            return;
        }
        let tid = crate::hooks::actor_type_id(actor as *const usize);
        let q_b = diag::read_ptr_guarded(actor, 0x19b8).unwrap_or(0);
        let q_e = diag::read_ptr_guarded(actor, 0x19c0).unwrap_or(0);
        let mut detail = String::new();
        if q_e != 0 && q_b != q_e && diag::readable(q_e.wrapping_sub(0x110), 0x120) {
            let cur_hash = diag::read_u32_guarded(q_e - 0x108, 0);
            let map_hdr = diag::read_ptr_guarded(q_e - 0x78, 0).unwrap_or(0);
            detail.push_str(&format!(" cur_hash={cur_hash:#x} map={map_hdr:#x}"));
            if map_hdr != 0 && diag::readable(map_hdr, 0x28) {
                // bounded DFS over the MSVC map: node = {left,parent,right,color,isnil@0x19,key@0x20,...,val@0x68}
                let root = diag::read_ptr_guarded(map_hdr, 8).unwrap_or(0);
                let mut stack = vec![root];
                let mut cnt = 0;
                while let Some(nd) = stack.pop() {
                    if nd == 0 || nd == map_hdr || !diag::readable(nd, 0x70) || cnt >= 8 {
                        continue;
                    }
                    if diag::read_bytes_guarded(nd, 0x19, 1).map(|v| v[0]) == Some(1) {
                        continue;
                    }
                    cnt += 1;
                    let key = diag::read_u32_guarded(nd, 0x20);
                    let val = diag::read_ptr_guarded(nd, 0x68).unwrap_or(0);
                    let status = if val != 0 && diag::readable(val, 0x40) {
                        diag::read_u32_guarded(val, 0x38) as i32
                    } else {
                        -1
                    };
                    detail.push_str(&format!(" [k={key:#x} v={val:#x} st={status}]"));
                    stack.push(diag::read_ptr_guarded(nd, 0).unwrap_or(0));
                    stack.push(diag::read_ptr_guarded(nd, 0x10).unwrap_or(0));
                }
            }
        }
        diag::ev!(
            "appear_boss",
            "t{tick} actor={actor:#x} tid={tid:#x} hflags={hflags:#x} q_b={q_b:#x} q_e={q_e:#x} empty={}{detail}",
            q_b == q_e
        );
    }

    fn sample_flow(mgr: usize, tick: u32) {
        let flow = diag::read_ptr_guarded(mgr, 0x210).unwrap_or(0);
        if flow == 0 {
            diag::ev!("appear_flow", "t{tick} no-flow");
            return;
        }
        let ftype = diag::read_u32_guarded(flow, super::FLOW_TYPE_OFFSET);
        let main_uuid = diag::read_u64_guarded(flow, 0x320).unwrap_or(0);
        let sub_uuid = diag::read_u64_guarded(flow, 0x348).unwrap_or(0);
        let point_uuid = diag::read_u64_guarded(flow, 0x4d0).unwrap_or(0);
        let fwin = diag::read_bytes_guarded(flow, 0xe8, 16)
            .map(|b| b.iter().map(|x| format!("{x:02x}")).collect::<String>())
            .unwrap_or_else(|| "??".into());
        // ReceptionState id (decompile-confirmed): u32 at flow+0x2d8. 9=WaitStartEvent,
        // 0xc/0xd=in-game, 0xe=boss-appear driver, 0xf=appear cinematic.
        let state = diag::read_u32_guarded(flow, 0x2d8);
        // Appear countdown in updateWaitStartEvent (i32 at +0x794): 0->prep(set 2)->1->request.
        let cntdn = diag::read_u32_guarded(flow, 0x794);
        // Driver latches: +0x700 (telop shown), +0x701 (telop wait bypass), +0x702.
        let latch = diag::read_bytes_guarded(flow, 0x700, 3)
            .map(|b| b.iter().map(|x| format!("{x:02x}")).collect::<String>())
            .unwrap_or_else(|| "??".into());
        let quest_id = diag::read_u32_guarded(flow, 0x40);
        diag::ev!(
            "appear_flow",
            "t{tick} flow={flow:#x} type={ftype:#x} quest={quest_id:#x} state={state:#x} cntdn={cntdn} main={main_uuid:#x} sub={sub_uuid:#x} point={point_uuid:#x} f0xe8={fwin} l0x700={latch}"
        );
        // AUTO-SKIP EXPERIMENT: state 0xf (wait boss-appear event) hangs when the
        // dormant boss never processes the queued appear event. `flow+0xeb` is the
        // game's own "player skipped the appear event" flag — the 0xf handler then
        // takes its first-class skip path (fade -> state 0x34 -> endless 0x36 ->
        // fight). Force it once after 20 consecutive stuck ticks, endless rooms only.
        //
        // The type check is load-bearing, not belt-and-braces. This samples the
        // reception-flow SLOT once a second for 150 s, and the slot is replaced (and
        // the old flow freed) the moment the player leaves the room — so `flow` can
        // be a different flow class, or freed memory, by the time the counter
        // matures. Every other access here goes through `diag`'s guarded readers,
        // whose contract is that a probe can NEVER fault the game; this is the one
        // WRITE, so it re-establishes the same footing by hand: the object must
        // still stamp itself as an EndlessMode flow AND the byte must still be
        // mapped. Without both, a stale slot whose +0x2d8 happens to read 0xf pokes
        // an unrelated (or dead) object on the game's behalf.
        let endless_flow = ftype == super::ENDLESS_FLOW_TYPE;
        if endless_flow && state == 0xf && (quest_id >> 20) == 8 {
            let n = STUCK_0XF.fetch_add(1, Ordering::SeqCst) + 1;
            if n >= 20 && !SKIP_FIRED.swap(true, Ordering::SeqCst) {
                if diag::readable(flow, 0xec) {
                    unsafe {
                        *((flow + 0xeb) as *mut u8) = 1;
                    }
                    diag::ev!(
                        "appear_skip",
                        "state 0xf stuck {n}s -> forced flow+0xeb=1 (boss-appear skip path)"
                    );
                } else {
                    diag::ev!(
                        "appear_skip",
                        "state 0xf stuck {n}s but flow={flow:#x} is no longer mapped — skip NOT forced"
                    );
                }
            }
        } else {
            STUCK_0XF.store(0, Ordering::SeqCst);
        }
    }

    /// Walk every scene's uuid->slot map, mirroring `FUN_141f7e8f0`'s addressing:
    /// scene list `[DAT_147ab3150]+0x20` -> `+0x60` circular links; per elem the map
    /// holder at `+0x30` with list-end at `+0x88`; entries are list nodes (`next` at
    /// +0, key u64 at +0x28, slot u32 at +0x30) indexing an actor array at `+0xf0`.
    /// Layout guesses are logged raw, so even a partially-wrong walk yields data.
    fn walk_scene_maps(tick: u32) {
        let base = diag::MODULE_BASE.load(Ordering::Relaxed);
        if base == 0 {
            return;
        }
        let Some((smgr, inner, sent)) = scene_map_roots() else {
            diag::ev!("appear_map", "t{tick} scene-mgr unreadable");
            return;
        };
        diag::ev!(
            "appear_map",
            "t{tick} smgr={smgr:#x} inner={inner:#x} sent={sent:#x}"
        );
        for_each_scene_map(sent, |ei, holder, arr| {
            let mask = diag::read_u64_guarded(holder, 0xb0).unwrap_or(0);
            let mut hit = false;
            let mut lines = String::new();
            let n = for_each_scene_node(holder, |key, slot| {
                if key > 0xFFFF_FFFF {
                    let actor = if arr != 0 {
                        diag::read_ptr_guarded(arr, (slot as usize) * 0x10).unwrap_or(0)
                    } else {
                        0
                    };
                    // The map values are runtime placement-object instances
                    // (FUN_141f7e600: type tag u32 at +0x158, e.g. 0x30b = point;
                    // world position 3×f32 at +0x170). Log tag + position + vtable
                    // RVA so each key can be matched to its placement-file node
                    // offline (the boss node sits at a unique position).
                    // The vtable is read ONCE and the range check uses that same
                    // value. Reading it a second time to subtract `base` from would
                    // race the game thread: a re-read that comes back unreadable
                    // (`None`) yields 0, and `0 - base` underflows — a panic that
                    // kills this probe thread in a debug hook, and a garbage RVA in
                    // the log in a release one.
                    let vtable = diag::read_ptr_guarded(actor, 0)
                        .filter(|&vt| vt > base && vt < base + 0x9000000);
                    let (vt_rva, tag, px, py, pz) = if let (true, Some(vt)) =
                        (actor != 0 && diag::readable(actor, 0x190), vtable)
                    {
                        let vt = vt - base;
                        let tag = diag::read_u32_guarded(actor, 0x158);
                        let p = diag::read_bytes_guarded(actor, 0x170, 12)
                            .map(|b| {
                                (
                                    f32::from_le_bytes(b[0..4].try_into().unwrap()),
                                    f32::from_le_bytes(b[4..8].try_into().unwrap()),
                                    f32::from_le_bytes(b[8..12].try_into().unwrap()),
                                )
                            })
                            .unwrap_or((f32::NAN, f32::NAN, f32::NAN));
                        (vt, tag, p.0, p.1, p.2)
                    } else {
                        (0, 0, f32::NAN, f32::NAN, f32::NAN)
                    };
                    // build10+ re-keys the low 14 bits per room; match on the high 50.
                    if key >> 14 == GRAFT_UUID >> 14 {
                        hit = true;
                    }
                    lines.push_str(&format!(
                        " {key:#x}->s{slot}/vt{vt_rva:#x}/g{tag:#x}@({px:.1},{py:.1},{pz:.1})"
                    ));
                }
                ControlFlow::Continue(())
            });
            diag::ev!(
                "appear_map",
                "t{tick} scene{ei} holder={holder:#x} mask={mask:#x} nodes={n} graft_hit={hit} entries:{lines}"
            );
            ControlFlow::Continue(())
        });
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
            crate::hooks::diag::ev!(
                "endless_buff",
                "buff_this={:#x} buff_id={buff_id:#x}",
                a1 as usize
            );
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
        log::warn!(
            "CONFLUX hook: mgr_dtor (run-end) manager={:#x}",
            a1 as usize
        );
        let _ = self.tx.send(protocol::Message::ConfluxRunEnd(
            protocol::ConfluxRunEndEvent {
                manager_ptr: a1 as u64,
            },
        ));

        #[cfg(feature = "hookdiag")]
        {
            crate::hooks::diag::ev!("endless_run_end", "manager={:#x}", a1 as usize);
            crate::hooks::diag::probe_u32_window_delta("reception_mgr", a1 as usize, 0x800);
        }

        unsafe { OnEndlessMgrDtor.call(a1) }
    }
}

#[cfg(all(test, feature = "hookdiag"))]
mod tests {
    use super::BOSS_NEEDLES;
    use crate::hooks::gamehash::game_xxhash32;

    /// [`BOSS_NEEDLES`] carries 58 hand-transcribed hex literals. A typo makes
    /// that needle silently never match — which is indistinguishable from "the
    /// boss id is not stored here", the exact question the probe exists to
    /// answer. So every literal is re-derived from its own label here rather
    /// than trusted: the hashes through the hook's own `game_xxhash32` (the
    /// same function `summon.rs` derives engine hashes with at runtime), the
    /// packed quest ids through the `0x20000 | id` encoding.
    #[test]
    fn every_needle_matches_the_identity_its_label_names() {
        for &(value, label) in BOSS_NEEDLES {
            let expected = match label.strip_prefix('h') {
                // `hEm####` — the actor-type hash, XXHash32Custom of "Em####".
                Some(name) => game_xxhash32(name.as_bytes()),
                // `Em####` — the packed quest id: the four digits, read as hex.
                None => {
                    let digits = label
                        .strip_prefix("Em")
                        .unwrap_or_else(|| panic!("needle label {label} is not an Em id"));
                    let id = u32::from_str_radix(digits, 16)
                        .unwrap_or_else(|_| panic!("needle label {label} has non-hex digits"));
                    0x20000 | id
                }
            };
            assert_eq!(value, expected, "needle {label} carries the wrong value");
        }
    }

    /// Each boss contributes a packed-id and a hash needle, so the table must
    /// be an exact pairing — a dropped half is a silently half-covered boss.
    #[test]
    fn every_boss_carries_both_a_packed_id_and_a_hash() {
        let hashes = BOSS_NEEDLES
            .iter()
            .filter(|(_, l)| l.starts_with('h'))
            .count();
        assert_eq!(hashes * 2, BOSS_NEEDLES.len());
        for (index, (_, label)) in BOSS_NEEDLES.iter().enumerate().step_by(2) {
            assert_eq!(BOSS_NEEDLES[index + 1].1, format!("h{label}"));
        }
    }
}
