//! Client for the hook's toolbox RPC channel (one request per connection),
//! plus [`HookStatus`] — what the commands consult before calling so that
//! "game not running", "hook outdated", and "hook unreachable" each surface
//! as the right thing in the UI.

use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use protocol::toolbox::{OvermasterySnapshot, SynthesisSeed, SynthesisSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

/// Managed Tauri state, kept current by the event-stream connect loop in
/// main.rs. Both flags default to false.
#[derive(Default)]
pub struct HookStatus {
    /// True while the event stream is connected (the hook is alive).
    pub connected: AtomicBool,
    /// True when the hook's Hello failed or reported another protocol
    /// version — e.g. a stale Linux dinput8 proxy until the game restarts,
    /// or a pre-RPC hook that refuses the connection outright.
    pub outdated: AtomicBool,
}

/// A wedged hook (or frozen game) must not hang a Tauri command.
const RPC_TIMEOUT: Duration = Duration::from_secs(2);

async fn exchange<S>(stream: S, req: &ToolboxRequest) -> Result<ToolboxResponse>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    framed
        .send(protocol::bincode::serialize(req)?.into())
        .await?;
    match framed.next().await {
        Some(Ok(frame)) => Ok(protocol::bincode::deserialize(&frame)?),
        Some(Err(e)) => Err(e.into()),
        None => bail!("toolbox channel closed before responding"),
    }
}

/// Same transport selection as `connect_event_stream` in main.rs: pipe on
/// native Windows, TCP under GBFR_LOGS_FORCE_TCP=1 and on Linux.
async fn call_inner(req: &ToolboxRequest) -> Result<ToolboxResponse> {
    #[cfg(windows)]
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        // TOOLBOX_PIPE_NAME referenced fully qualified: a top-level import
        // would be an unused-import warning in the Linux build.
        use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};
        let stream = DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(
            protocol::toolbox::TOOLBOX_PIPE_NAME,
        )
        .await?;
        return exchange(stream, req).await;
    }
    let stream = tokio::net::TcpStream::connect(TOOLBOX_TCP_ADDR).await?;
    exchange(stream, req).await
}

pub async fn call(req: ToolboxRequest) -> Result<ToolboxResponse> {
    tokio::time::timeout(RPC_TIMEOUT, call_inner(&req))
        .await
        .context("toolbox rpc timed out")?
}

/// True only when the hook answers Hello with OUR protocol version. Called
/// by the connect loop each time the event stream (re)connects.
pub async fn hello_ok() -> bool {
    matches!(
        call(ToolboxRequest::Hello).await,
        Ok(ToolboxResponse::Hello { protocol_version })
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
}
