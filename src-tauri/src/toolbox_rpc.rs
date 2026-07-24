//! Client for the hook's toolbox RPC channel (one request per connection),
//! plus [`HookStatus`] — what the commands consult before calling so that
//! "game not running", "hook outdated", and "hook unreachable" each surface
//! as the right thing in the UI.

use anyhow::Result;
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use protocol::toolbox::{OvermasterySnapshot, SynthesisSeed, SynthesisSnapshot};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Managed Tauri state, kept current by the event-stream connect loop in
/// main.rs. All flags default to false and `hook_version` to `None`.
#[derive(Default)]
pub struct HookStatus {
    /// True while the event stream is connected (the hook is alive).
    pub connected: AtomicBool,
    /// True when the hook's Hello failed or reported another protocol version.
    pub outdated: AtomicBool,
    /// Dev/refresh hook teardown in flight: the injection loop must not
    /// re-inject until the old module is ejected. See `reload_hook`/`refresh_hook`.
    pub reloading: AtomicBool,
    /// The connected hook's build version, from its Hello. None until the
    /// first successful Hello.
    pub hook_version: Mutex<Option<String>>,
    /// True when the connected hook advertised the `eject` control channel.
    pub supports_eject: AtomicBool,
}

/// The user-facing hook state, computed by `HookStatus::snapshot`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum HookState {
    /// Pipe up, Hello OK, hook version matches the app.
    Connected,
    /// A refresh/reload is in flight.
    Reconnecting,
    /// Version differs from the app, or the protocol/Hello mismatched.
    OutOfDate,
    /// No hook / game not running.
    Disconnected,
}

/// Snapshot pushed to the frontend (`hook-status` event, `get_hook_status`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HookStatusSnapshot {
    pub state: HookState,
    pub hook_version: Option<String>,
    pub app_version: String,
    /// Whether `refresh_hook` can act (vs. "restart the game").
    pub supports_eject: bool,
}

impl HookStatus {
    /// Fold the atomics + the app's own version into the user-facing state.
    pub fn snapshot(&self) -> HookStatusSnapshot {
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let hook_version = self.hook_version.lock().unwrap().clone();
        let supports_eject = self.supports_eject.load(Ordering::Relaxed);

        // A dev hook (or not-yet-known version) is never flagged on version
        // difference alone; only a real, differing release version is.
        let version_mismatch = match hook_version.as_deref() {
            None | Some(protocol::toolbox::HOOK_DEV_VERSION) => false,
            Some(v) => v != app_version,
        };

        let state = if self.reloading.load(Ordering::Relaxed) {
            HookState::Reconnecting
        } else if !self.connected.load(Ordering::Relaxed) {
            HookState::Disconnected
        } else if self.outdated.load(Ordering::Relaxed) || version_mismatch {
            HookState::OutOfDate
        } else {
            HookState::Connected
        };

        HookStatusSnapshot { state, hook_version, app_version, supports_eject }
    }
}

/// A wedged hook (or frozen game) must not hang a Tauri command.
const RPC_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn call(req: ToolboxRequest) -> Result<ToolboxResponse> {
    crate::rpc::call(
        protocol::toolbox::TOOLBOX_PIPE_NAME,
        TOOLBOX_TCP_ADDR,
        RPC_TIMEOUT,
        req,
    )
    .await
}

/// True only when the hook answers Hello with OUR protocol version. Called
/// by the connect loop each time the event stream (re)connects.
pub async fn hello_ok() -> bool {
    matches!(
        call(ToolboxRequest::Hello).await,
        Ok(ToolboxResponse::Hello { protocol_version, .. })
            if protocol_version == TOOLBOX_PROTOCOL_VERSION
    )
}

/// Shared precondition for every toolbox command. `Ok(None)` = the event
/// stream is down, which the tools present as "game not running". The two
/// error slugs are mapped to friendly copy in src/backendErrors.ts; remote
/// error strings (e.g. "still on title screen?") pass through verbatim.
async fn request(hook: &HookStatus, req: ToolboxRequest) -> Result<Option<ToolboxResponse>, String> {
    if !hook.connected.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if hook.outdated.load(Ordering::Relaxed) {
        return Err("hook-outdated".into());
    }
    match call(req).await {
        Ok(resp) => Ok(Some(resp)),
        Err(e) => {
            log::warn!("toolbox rpc failed: {e:?}");
            Err("hook-unreachable".into())
        }
    }
}

pub async fn synthesis_snapshot(hook: &HookStatus) -> Result<Option<SynthesisSnapshot>, String> {
    match request(hook, ToolboxRequest::SynthesisSnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn synthesis_seed(hook: &HookStatus) -> Result<Option<SynthesisSeed>, String> {
    match request(hook, ToolboxRequest::SynthesisSeed).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSeed(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn overmastery_snapshot(hook: &HookStatus) -> Result<Option<OvermasterySnapshot>, String> {
    match request(hook, ToolboxRequest::OvermasterySnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::OvermasterySnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn overmastery_slot(hook: &HookStatus, slot: u32) -> Result<Option<u32>, String> {
    match request(hook, ToolboxRequest::OvermasterySlot(slot)).await? {
        None => Ok(None),
        Some(ToolboxResponse::OvermasterySlot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gating rules the frontend copy depends on, without any live hook.
    #[tokio::test]
    async fn disconnected_hook_reads_as_game_not_running() {
        let hook = HookStatus::default();
        assert_eq!(synthesis_snapshot(&hook).await, Ok(None));
    }

    #[tokio::test]
    async fn outdated_hook_maps_to_its_slug() {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        hook.outdated.store(true, Ordering::Relaxed);
        assert_eq!(
            synthesis_snapshot(&hook).await,
            Err("hook-outdated".to_string())
        );
    }

    /// connected + current but nothing listening (no game in tests) → the
    /// unreachable slug, not a hang (RPC_TIMEOUT bounds it).
    #[tokio::test]
    async fn unreachable_hook_maps_to_its_slug() {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        assert_eq!(
            synthesis_snapshot(&hook).await,
            Err("hook-unreachable".to_string())
        );
    }

    fn connected_hook(hook_version: Option<&str>, supports_eject: bool) -> HookStatus {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        *hook.hook_version.lock().unwrap() = hook_version.map(String::from);
        hook.supports_eject.store(supports_eject, Ordering::Relaxed);
        hook
    }

    #[test]
    fn snapshot_disconnected_when_pipe_down() {
        assert_eq!(HookStatus::default().snapshot().state, HookState::Disconnected);
    }

    #[test]
    fn snapshot_reconnecting_takes_precedence() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.reloading.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Reconnecting);
    }

    #[test]
    fn snapshot_connected_when_versions_match() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    #[test]
    fn snapshot_out_of_date_on_version_difference() {
        let hook = connected_hook(Some("0.0.1-old"), true);
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);
    }

    #[test]
    fn snapshot_out_of_date_on_protocol_mismatch() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.outdated.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);
    }

    #[test]
    fn snapshot_dev_hook_never_flagged_on_version() {
        let hook = connected_hook(Some(protocol::toolbox::HOOK_DEV_VERSION), true);
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }
}
