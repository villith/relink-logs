//! Dev-only (feature `eject`): graceful self-teardown so the app can
//! FreeLibrary this module and inject a rebuilt one without a game restart.
//!
//! Sequence (see the design spec): the control channel's `serve` task calls
//! [`begin`] AFTER flushing the Eject response; we disable every detour, wait
//! a drain period for game threads still inside a trampoline, then signal
//! [`shutdown_notified`] so `setup()` exits its runtime — which closes the
//! event/toolbox/control listeners, the app's cue to eject the module.

use std::time::Duration;

use tokio::sync::Notify;

static SHUTDOWN: Notify = Notify::const_new();

/// Resolves once teardown has finished; `setup()` selects on this to exit
/// the runtime (dropping every listener → the app sees the pipe close).
pub async fn shutdown_notified() {
    SHUTDOWN.notified().await;
}

/// Disable all detours, drain, then signal shutdown. Must be called from
/// within the hook's tokio runtime.
pub fn begin() {
    tokio::spawn(async {
        crate::hooks::teardown_hooks();
        // Drain: a game thread that entered a trampoline just before the
        // disable must fall out before this module can be unmapped. The app
        // waits a further grace on its side after the pipe closes.
        tokio::time::sleep(Duration::from_millis(300)).await;
        // notify_one stores a permit, so the signal is never lost even if
        // nothing is awaiting yet.
        SHUTDOWN.notify_one();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Covers the whole in-process teardown path against a non-game binary:
    /// begin() must disable (no-op here), drain, and signal — never hang.
    #[tokio::test]
    async fn begin_tears_down_and_signals_shutdown() {
        begin();
        tokio::time::timeout(std::time::Duration::from_secs(5), shutdown_notified())
            .await
            .expect("teardown never signaled shutdown");
    }
}
