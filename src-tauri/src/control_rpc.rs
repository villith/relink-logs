//! Client for the hook's control channel (feature `eject` hooks).
//!
//! Separate from `toolbox_rpc`: the control channel carries hook-lifecycle
//! and dev-only commands (`Eject`, `BroadcastEvents`, `SetHelloOverride`).
//! `eject` backs the hook refresh flow (`refresh_hook`/`reload_hook` in
//! main.rs); the other two back the Debug tab driving real hook events.

use anyhow::{bail, Context, Result};
use protocol::control::{
    HelloOverride, HookControlRequest, HookControlResponse, HOOK_CONTROL_PIPE_NAME,
};
use std::time::Duration;

/// Bounds every call on this channel: the reload flow needs it so a wedged
/// hook can't hang a reload, and `broadcast_events`/`set_hello_override` need
/// it so a missing dev hook fails fast instead of hanging the Debug tab.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);

async fn call(req: HookControlRequest) -> Result<HookControlResponse> {
    crate::rpc::call(
        HOOK_CONTROL_PIPE_NAME,
        protocol::control::HOOK_CONTROL_TCP_ADDR,
        CONTROL_TIMEOUT,
        req,
    )
    .await
    .context("hook control channel")
}

/// Ask the hook to tear itself down (feature `eject` builds only). Raw errors
/// for the reload toast — no frontend slug mapping. A hook without the `eject`
/// feature has no control listener, so this surfaces as a connection error.
pub async fn eject() -> Result<()> {
    match call(HookControlRequest::Eject).await? {
        HookControlResponse::Eject(Ok(())) => Ok(()),
        HookControlResponse::Eject(Err(e)) => bail!("hook refused eject: {e}"),
        other => bail!("eject: unexpected control response: {other:?}"),
    }
}

/// Ask the hook to rebroadcast these messages on the event stream. Returns how
/// many the hook QUEUED onto the broadcast channel; 0 means nothing is
/// subscribed to the stream. Queued is not the same as seen by the app: the
/// channel holds 1024 and a lagging receiver ends the app's event-stream loop,
/// so keep batches small (scenarios are 1-4 messages).
pub async fn broadcast_events(msgs: Vec<protocol::Message>) -> Result<u32> {
    // An empty batch would also answer 0, which the caller reads as "nothing is
    // subscribed" — a different and much more alarming thing. Refuse it here,
    // the only place that can still tell the two apart.
    if msgs.is_empty() {
        bail!("refusing to broadcast an empty batch");
    }
    match call(HookControlRequest::BroadcastEvents(msgs)).await? {
        HookControlResponse::BroadcastEvents(Ok(n)) => Ok(n),
        HookControlResponse::BroadcastEvents(Err(e)) => bail!("hook refused broadcast: {e}"),
        other => bail!("broadcast: unexpected control response: {other:?}"),
    }
}

/// Install (or, with `None`, clear) the hook's dev `Hello` override.
pub async fn set_hello_override(o: Option<HelloOverride>) -> Result<()> {
    match call(HookControlRequest::SetHelloOverride(o)).await? {
        HookControlResponse::SetHelloOverride(Ok(())) => Ok(()),
        HookControlResponse::SetHelloOverride(Err(e)) => bail!("hook refused override: {e}"),
        other => bail!("hello override: unexpected control response: {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty batch would return Ok(0), which the caller cannot distinguish
    /// from "nothing is subscribed to the event stream".
    #[tokio::test]
    async fn broadcast_events_refuses_an_empty_batch() {
        let err = broadcast_events(Vec::new()).await.unwrap_err();
        assert!(err.to_string().contains("empty batch"), "got: {err}");
    }
}
