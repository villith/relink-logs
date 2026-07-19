use std::sync::atomic::Ordering;

use anyhow::{anyhow, Result};
use protocol::Message;
use retour::static_detour;

use crate::{
    event,
    hooks::{
        diag::read_u32_guarded,
        endless::{ENDLESS_FLOW_TYPE, FLOW_TYPE_OFFSET},
        ffi::QuestState,
        globals::QUEST_STATE_PTR,
    },
    process::Process,
};

type OnLoadQuestStateFunc = unsafe extern "system" fn(*const usize) -> usize;
// v2.0.2: the result-screen handler is a TWO-argument function `fn(rcx=ptr, edx=u32)`.
// It was previously (mis)declared as one argument; calling the detour tail with only
// one argument left the second register garbage and crashed the game inside the real
// function (access violation). See ON_SHOW_RESULT_SCREEN_SIG below.
type OnShowResultScreenFunc = unsafe extern "system" fn(*const usize, u32) -> usize;

static_detour! {
    static OnLoadQuestState: unsafe extern "system" fn(*const usize) -> usize;
    static OnShowResultScreen: unsafe extern "system" fn(*const usize, u32) -> usize;
}

// v2.0.2: on_load_quest_state is FUN_14063ecb0 (rva 0x63ecb0), a clean 1-arg entry
// `fn(rcx)` — confirmed via Ghidra (prologue `mov rsi,rcx; mov eax,[rcx+0xdc8]`, then an
// FNV-1a hash + quest-table lookup; only rcx is used). This call-follow sig still
// resolves correctly to that entry (the `call` at rva 0x1bfd0bd, its sole caller).
const ON_LOAD_QUEST_STATE: &str =
    "48 8b 0d ? ? ? ? e8 $ { ' } c5 fb 12 ? ? ? ? ? c5 f8 11 ? ? ? ? ? c5 f8 11 ? ? ? ? ? c7 87";
// v2.0.2: on_show_result_screen is FUN_1403f1330 (rva 0x3f1330), a TWO-arg function
// `fn(rcx=StateMgr*, edx=u32 resultType<0x13)`. The old call-follow sig resolved to a
// CALLEE of this function (the helper @0x6238f0) — not the real entry — and hooking that
// callee with the wrong arity crashed the game. This signature instead lands directly on
// the true entry: the preceding function's `ret` (c3) + int3 padding, then the entry
// prologue, with the cursor (') placed exactly at 0x3f1330. Verified unique (1 match)
// resolving to 0x3f1330 via the sigscan harness.
const ON_SHOW_RESULT_SCREEN_SIG: &str =
    "c3 cc cc cc cc ' 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 90 00 00 00 83 fa 13";

/// Result-type enum values (arg2 of FUN_1403f1330) that mark the END of a quest.
/// Confirmed live: 0/3/4 at load, 5 = the genuine quest-complete result screen,
/// 6 AND 7 are mid-mission noise. Type 7 was briefly treated as a quest end (it
/// appeared to terminate an Endless Ragnarok quest), but three live captures show
/// combat (SBA attempts) CONTINUING after every type-7 — including one where the
/// genuine type-5 followed 38s later, which split that quest into two saved logs.
/// The router itself treats 6/7 as siblings (`(type & ~1) == 6` guard), and the
/// decompile shows it's a per-screen voice/banner cue table, not a quest-clear
/// flag. The quest that looked like it "ended with 7" actually ended with NO
/// result screen at all (fail/retire) — that boundary is now covered by the
/// quest-load cut in OnLoadQuestHook below, not by guessing at result types.
const RESULT_TYPES_QUEST_END: [u32; 1] = [5];

/// Called while loading into a quest.
#[derive(Clone)]
pub struct OnLoadQuestHook {
    tx: event::Tx,
}

impl OnLoadQuestHook {
    pub fn new(tx: event::Tx) -> Self {
        OnLoadQuestHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(on_load_quest_state) = process.search_address(ON_LOAD_QUEST_STATE) {
            #[cfg(feature = "console")]
            println!("Found on load quest state");

            unsafe {
                let func: OnLoadQuestStateFunc = std::mem::transmute(on_load_quest_state);
                OnLoadQuestState.initialize(func, move |a1| cloned_self.run(a1))?;
                OnLoadQuestState.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_load_quest_state"));
        }

        Ok(())
    }

    fn run(&self, a1: *const usize) -> usize {
        #[cfg(feature = "console")]
        println!("on load quest state");

        // hookdiag probes budget per QUEST, not per session: the 2026-07-18 online run
        // proved the one-shot budgets (stun_scan's 64 targets, ARDIAG's 64 actors) get
        // exhausted by town/solo play before the interesting quest ever loads.
        #[cfg(feature = "hookdiag")]
        {
            super::damage::reset_stun_scan_budget();
            super::player::reset_ardiag_seen();
            super::stunnet::reset_budget();
        }

        // Quest-load boundary cut (v2.0.2). The area-enter hook no longer installs, so
        // this is the only reliable between-quest cut point. A quest that ends WITHOUT
        // the type-5 result screen (fail, retire — live-confirmed to emit nothing)
        // would otherwise keep its encounter open and merge into the next quest's log.
        // Emitting OnAreaEnter here lets the parser save any in-progress encounter
        // (on_area_enter_event) and start the next one. The quest id read here is the
        // INCOMING quest's: a1+0xDC8 is populated by the caller before this function
        // runs (the loader below READS it — FNV-hashes it for the quest-table lookup),
        // so the parser must stamp it on the NEW encounter, never on the one it is
        // saving (that one keeps the id from its own load; getting this backwards
        // labeled failed quests with the quest that was just started). Reads are
        // guarded: a garbage id on a damage-less encounter is harmless, a bad deref
        // inside a hook freezes the game.
        //
        // Conflux room loads must NOT emit this: each room is its own quest load, and
        // an area-enter would finalize the active run at every room boundary. The
        // reception dispatcher runs before the quest load (live-verified ordering), so
        // an EndlessMode flow already sitting in the manager slot means "room load" —
        // rooms are cut by ConfluxRoomEnter instead (endless.rs).
        let reception_flow = unsafe { a1.byte_add(0x210).read() };
        let flow_type = read_u32_guarded(reception_flow, FLOW_TYPE_OFFSET);
        if flow_type != ENDLESS_FLOW_TYPE {
            let incoming_quest_state = a1 as usize + 0xDC8;
            let _ = self.tx.send(Message::OnAreaEnter(protocol::AreaEnterEvent {
                last_known_quest_id: read_u32_guarded(incoming_quest_state, 0),
                last_known_elapsed_time_in_secs: read_u32_guarded(incoming_quest_state, 0x64C),
            }));
        }

        let ret = unsafe { OnLoadQuestState.call(a1) };
        // v2.0.2: the QuestState block moved from manager+0x1D8 to manager+0xDC8.
        // Confirmed via Ghidra decompile of FUN_14063ecb0 (this hooked function): it
        // reads the quest id as `*(uint*)(rcx + 0xdc8)` and FNV-1a-hashes it for the
        // quest-table lookup; its caller (FUN_141bfcdd0) validates the same dword with
        // a quest-id mask (`& 0xf00000`). The old +0x1D8 slot now holds a static
        // POINTER — reading it as a u32 produced the constant bogus id 0xFADBB940
        // stamped on every saved log.
        let quest_state_ptr = unsafe { a1.byte_add(0xDC8) } as *mut QuestState;

        if quest_state_ptr.is_null() {
            return ret;
        }

        QUEST_STATE_PTR.store(quest_state_ptr, std::sync::atomic::Ordering::Relaxed);

        // NOTE: the Conflux ROOM-ENTER signal is emitted by the reception-flow dispatcher
        // (hooks/endless.rs), NOT here — that hook fires once per room with the manager
        // pointer the parser needs for run identity. This hook stores QUEST_STATE_PTR
        // (above) for the quest-complete path and emits the between-quest boundary cut
        // (before the original call, above) for NON-Conflux loads.

        // Conflux/EndlessMode instrumentation (hookdiag-only). `a1` is the stage-quest
        // manager: QuestState lives at +0x1D8 and the reception-flow singleton slot at
        // +0x210 (see FUN_140638690 / hooks/endless.rs). Each Conflux ROOM is an isolated
        // quest load, so this fires once per room; the reception-flow pointer tells us
        // whether we're inside an EndlessMode run, and the wide u32 scan lets a playthrough
        // reveal which field is the room/run counter (whatever increments room→room).
        #[cfg(feature = "hookdiag")]
        {
            let quest_id = unsafe { (*quest_state_ptr).quest_id };
            let reception_flow = unsafe { a1.byte_add(0x210).read() };
            crate::hooks::diag::ev!(
                "endless_quest_load",
                "quest_id={quest_id:#x} reception_flow={reception_flow:#x}"
            );
            // `a1` (the stage-quest manager) persists across rooms, so the room/run counter is
            // a field that increments in place — use the delta probe so each room load logs
            // exactly what CHANGED since the previous room, not a full snapshot every time.
            crate::hooks::diag::probe_u32_window_delta("quest_load", a1 as usize, 0x400);
        }

        ret
    }
}

/// Called whenever the result screen is shown for the quest.
#[derive(Clone)]
pub struct OnQuestCompleteHook {
    tx: event::Tx,
}

impl OnQuestCompleteHook {
    pub fn new(tx: event::Tx) -> Self {
        OnQuestCompleteHook { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        let cloned_self = self.clone();

        if let Ok(on_show_result_screen) = process.search_address(ON_SHOW_RESULT_SCREEN_SIG) {
            #[cfg(feature = "console")]
            println!("Found on show result screen");

            unsafe {
                let func: OnShowResultScreenFunc = std::mem::transmute(on_show_result_screen);
                OnShowResultScreen.initialize(func, move |a1, a2| cloned_self.run(a1, a2))?;
                OnShowResultScreen.enable()?;
            }
        } else {
            return Err(anyhow!("Could not find on_show_result_screen"));
        }

        Ok(())
    }

    // a1 = state-manager pointer (rcx); a2 = result-type enum (edx, < 0x13). We only
    // observe here and pass both through unchanged, so the real handler runs with the
    // arguments it expects (passing one argument crashed the game in v2.0.2).
    //
    // a2 is a result-type enum (0..=0x13). FUN_1403f1330 is a broad result/state router
    // that runs for MANY result types — NOT only on quest completion — so firing
    // OnQuestComplete unconditionally stopped and saved the encounter mid-battle (the
    // parser treats OnQuestComplete as "quest cleared -> stop + save").
    //
    // Live captures settled the values: types 0/3/4 appear at load, 6 AND 7 fire
    // mid-mission (combat provably continued after every observed 7), and **type 5 is
    // the genuine quest-complete** result screen. Gate strictly on
    // RESULT_TYPES_QUEST_END (see its doc for the type-7 post-mortem). Quests that end
    // with no result screen at all (fail/retire) are cut by the quest-load boundary in
    // OnLoadQuestHook instead.
    fn run(&self, a1: *const usize, a2: u32) -> usize {
        #[cfg(feature = "console")]
        println!("on show result screen (result_type={a2})");
        crate::hooks::diag::ev!("result_screen", "result_type={a2}");

        if RESULT_TYPES_QUEST_END.contains(&a2) {
            let quest_state_ptr = QUEST_STATE_PTR.load(Ordering::Relaxed);

            // If the quest state was never captured (e.g. we were injected mid-quest,
            // so on_load_quest_state hasn't fired yet), still send the completion with
            // quest_id 0: cutting + saving the encounter at the boundary matters more
            // than labeling it, and the parser treats 0 as "id unknown".
            let (quest_id, timer) = if quest_state_ptr.is_null() {
                (0, 0)
            } else {
                #[cfg(feature = "console")]
                println!("quest_state_ptr: {:p}", quest_state_ptr);

                let quest_state = unsafe { quest_state_ptr.read() };
                (quest_state.quest_id, quest_state.elapsed_time)
            };

            // v2.0.2 IGT verification: the QuestState base moved (0x1D8 -> 0xDC8,
            // Ghidra-confirmed via the quest-id read), but elapsed_time @ +0x64C within
            // the struct is only INFERRED — and DISPROVEN by the 2026-07-15 session:
            // the whole 0x640..0x660 neighborhood read 1 at both quest ends. Scan the
            // full struct window instead, logging u32s in a plausible timer range
            // (seconds ~ hundreds, frames ~ tens of thousands, ms ~ hundreds of
            // thousands); match against the on-screen IGT to pin the real offset.
            #[cfg(feature = "hookdiag")]
            {
                let base = quest_state_ptr as usize;
                let mut dump = String::new();
                for off in (0usize..0x800).step_by(4) {
                    let v = read_u32_guarded(base, off);
                    if (2..30_000_000).contains(&v) {
                        dump.push_str(&format!("+{off:#x}={v} "));
                    }
                }
                crate::hooks::diag::ev!(
                    "quest_end_igt",
                    "quest_id={quest_id:#x} elapsed@0x64C={timer} candidates: {dump}"
                );
            }

            let _ = self
                .tx
                .send(Message::OnQuestComplete(protocol::QuestCompleteEvent {
                    quest_id,
                    elapsed_time_in_secs: timer,
                }));
        }

        unsafe { OnShowResultScreen.call(a1, a2) }
    }
}
