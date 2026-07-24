//! Training-room ("Trial") lifecycle hooks.
//!
//! The training room has no quest flow object and never runs
//! `on_load_quest_state`. It is driven by TrialBattleManager at QM+0xA0.
//!
//! CRITICAL: neither emit below may be gated on a freeze latch or a
//! quest-complete flag. Training never runs `on_load_quest_state`, so both are
//! stale-set from the previous quest and would silently suppress every training
//! save. This is why these hooks live here and not in `quest.rs`.
//!
//! Signatures cross-referenced from an independent implementation, 2026-07-24.
//! Unverified against our own capture.

use anyhow::Result;
use protocol::Message;
use retour::static_detour;

use crate::hooks::diag;
use crate::{event, process::Process};

// fn(rcx = QM singleton)
type OnTrialQuitFunc = unsafe extern "system" fn(*const usize) -> usize;
// fn(qm, dl, r8b) — runs at trial START, tearing down the previous session.
type OnTrialTeardownFunc = unsafe extern "system" fn(*const usize, usize, usize) -> usize;

static_detour! {
    static OnTrialQuit: unsafe extern "system" fn(*const usize) -> usize;
    static OnTrialTeardown: unsafe extern "system" fn(*const usize, usize, usize) -> usize;
}

#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnTrialQuit", &OnTrialQuit);
    super::disable_quiet("OnTrialTeardown", &OnTrialTeardown);
}

// What the "Quit Training" click runs.
const TRIAL_QUIT_PROLOGUE_SIG: &str =
    "56 57 55 53 48 83 ec 28 48 8b 81 a0 00 00 00 80 78 48 00 0f 84 99 01 00 00";
const TRIAL_QUIT_CALLSITE_SIG: &str =
    "48 8b 35 7a b5 01 06 0f b6 59 60 48 8b 0d f7 db 04 06 e8 $ { ' } 88 9e 0e 01 00 00 80 3d 05 de";

// Fires at trial START. The in-training Restart button never leaves Trial mode
// and never runs the quit choke point, so this is the only signal that closes a
// run ended by Restart. Also covers the natural score/time-attack end.
const TRIAL_TEARDOWN_CALLSITE_SIG: &str =
    "89 be e0 3d 06 00 48 89 f1 31 d2 41 b0 01 e8 $ { ' } c6 86 92 3a 06 00 00";
const TRIAL_TEARDOWN_PROLOGUE_SIG: &str =
    "55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 88 00 00 00 48 8d ac 24 80 00 00 00 c5 f8 29 75 f0 48 c7 45 e8 fe ff ff ff 44 88 45 d7 88 55 c8 49 89 cd ba 05 00 00 00";

/// TrialBattleManager pointer on the QM singleton.
const QM_TRIAL_MANAGER_OFFSET: usize = 0xA0;
/// The manager's armed byte and delegate count — the quit function's own entry
/// gate, replicated so the emit stays trial-scoped. Self-cleaning after every
/// teardown, which is why the second of the two per-quit calls is inert.
const TRIAL_MGR_ARMED_OFFSET: usize = 0x48;
const TRIAL_MGR_DELEGATE_COUNT_OFFSET: usize = 0x20;

/// True when a trial is actually running. All reads guarded, fails closed.
fn trial_is_armed(qm: *const usize) -> bool {
    let Some(mgr) = diag::read_ptr_guarded(qm as usize, QM_TRIAL_MANAGER_OFFSET) else {
        return false;
    };
    if mgr == 0 {
        return false;
    }
    diag::read_u32_guarded(mgr, TRIAL_MGR_ARMED_OFFSET) & 0xFF != 0
        && diag::read_u32_guarded(mgr, TRIAL_MGR_DELEGATE_COUNT_OFFSET) != 0
}

#[derive(Clone)]
pub struct TrialHooks {
    tx: event::Tx,
}

impl TrialHooks {
    pub fn new(tx: event::Tx) -> Self {
        TrialHooks { tx }
    }

    pub fn setup(&self, process: &Process) -> Result<()> {
        // Fail closed: both AOBs must resolve to the same address, so a moved
        // callee makes the hook skip installation rather than mis-resolve.
        if let (Ok(callsite), Ok(prologue)) = (
            process.search_address(TRIAL_QUIT_CALLSITE_SIG),
            process.search_match_address(TRIAL_QUIT_PROLOGUE_SIG),
        ) {
            if callsite == prologue {
                #[cfg(feature = "console")]
                println!("Found trial-quit choke point (training room)");

                let cloned_self = self.clone();
                unsafe {
                    let func: OnTrialQuitFunc = std::mem::transmute(callsite);
                    OnTrialQuit.initialize(func, move |qm| {
                        // Emit BEFORE the original: the quit path tears the
                        // trial down and may not return to us.
                        if trial_is_armed(qm) {
                            let _ = cloned_self
                                .tx
                                .send(Message::OnTrialEnd(protocol::TrialLifecycleEvent {}));
                        }
                        OnTrialQuit.call(qm)
                    })?;
                    OnTrialQuit.enable()?;
                }
            }
        }

        if let (Ok(callsite), Ok(prologue)) = (
            process.search_address(TRIAL_TEARDOWN_CALLSITE_SIG),
            process.search_match_address(TRIAL_TEARDOWN_PROLOGUE_SIG),
        ) {
            if callsite == prologue {
                #[cfg(feature = "console")]
                println!("Found trial session-teardown (fires at trial START)");

                let cloned_self = self.clone();
                unsafe {
                    let func: OnTrialTeardownFunc = std::mem::transmute(callsite);
                    OnTrialTeardown.initialize(func, move |qm, completed, force| {
                        let _ = cloned_self
                            .tx
                            .send(Message::OnTrialStart(protocol::TrialLifecycleEvent {}));
                        OnTrialTeardown.call(qm, completed, force)
                    })?;
                    OnTrialTeardown.enable()?;
                }
            }
        }

        Ok(())
    }
}
