use std::sync::atomic::Ordering;

use anyhow::{anyhow, Result};
use protocol::Message;
use retour::static_detour;

use crate::{
    event,
    hooks::{ffi::QuestState, globals::QUEST_STATE_PTR},
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

/// Result-type enum value (arg2 of FUN_1403f1330) for the genuine quest-complete screen.
/// Confirmed live: 0/3/4 at load, 6 mid-mission (spurious), 5 = real completion.
const RESULT_TYPE_QUEST_COMPLETE: u32 = 5;

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

        let ret = unsafe { OnLoadQuestState.call(a1) };
        let quest_state_ptr = unsafe { a1.byte_add(0x1D8) } as *mut QuestState;

        if quest_state_ptr.is_null() {
            return ret;
        }

        QUEST_STATE_PTR.store(quest_state_ptr, std::sync::atomic::Ordering::Relaxed);

        // Conflux room boundary: if this quest load happens while an EndlessMode reception
        // flow is active, it's a ROOM enter. The reception-flow slot lives at manager+0x210;
        // its type-hash at flow+0x7c8 identifies EndlessMode. Emitting per-room lets the
        // parser cut off + save the previous room and group rooms under the run.
        let reception_flow = unsafe { a1.byte_add(0x210).read() };
        let flow_type = crate::hooks::diag::read_u32_guarded(reception_flow, 0x7c8);
        let quest_id_dbg = unsafe { (*quest_state_ptr).quest_id };
        // [CONFLUX-DIAG] logs EVERY quest load so we can see whether flow_type ever equals the
        // EndlessMode hash 0x887ae0b0 (the room-enter gate). If it never matches, the gate/offset
        // /timing is the bug for symptom 1 (rooms never save).
        log::info!(
            "CONFLUX hook: quest_load quest_id={:#x} reception_flow={:#x} flow_type={:#x} is_endless_room={}",
            quest_id_dbg,
            reception_flow,
            flow_type,
            flow_type == 0x887ae0b0
        );
        if flow_type == 0x887ae0b0 {
            let quest_id = unsafe { (*quest_state_ptr).quest_id };
            let _ = self.tx.send(Message::ConfluxRoomEnter(
                protocol::ConfluxRoomEnterEvent { quest_id },
            ));
        }

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
    // a2 is a result-type enum (0..=0x12). FUN_1403f1330 is a broad result/state router
    // that runs for MANY result types — NOT only on quest completion — so firing
    // OnQuestComplete unconditionally stopped and saved the encounter mid-battle (the
    // parser treats OnQuestComplete as "quest cleared -> stop + save").
    //
    // Live capture (hookdiag result_type log over one mission) settled the exact value:
    // types 0/3/4 appear at load, type 6 fires mid-mission (twice — these were the two
    // spurious saves), and **type 5 is the genuine quest-complete** shown on the result
    // screen at the end. So gate strictly on a2 == 5 (RESULT_TYPE_QUEST_COMPLETE).
    fn run(&self, a1: *const usize, a2: u32) -> usize {
        #[cfg(feature = "console")]
        println!("on show result screen (result_type={a2})");
        crate::hooks::diag::ev!("result_screen", "result_type={a2}");

        if a2 == RESULT_TYPE_QUEST_COMPLETE {
            let quest_state_ptr = QUEST_STATE_PTR.load(Ordering::Relaxed);

            if !quest_state_ptr.is_null() {
                #[cfg(feature = "console")]
                println!("quest_state_ptr: {:p}", quest_state_ptr);

                let quest_state = unsafe { quest_state_ptr.read() };
                let quest_id = quest_state.quest_id;
                let timer = quest_state.elapsed_time;

                let _ = self
                    .tx
                    .send(Message::OnQuestComplete(protocol::QuestCompleteEvent {
                        quest_id,
                        elapsed_time_in_secs: timer,
                    }));
            }
        }

        unsafe { OnShowResultScreen.call(a1, a2) }
    }
}
