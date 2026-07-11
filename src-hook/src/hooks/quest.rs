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
pub struct OnLoadQuestHook {}

impl OnLoadQuestHook {
    pub fn new() -> Self {
        OnLoadQuestHook {}
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
