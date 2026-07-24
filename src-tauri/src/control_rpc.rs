//! Client for the hook's control channel (feature `eject` hooks).
//!
//! Separate from `toolbox_rpc`: the control channel carries hook-lifecycle
//! commands (currently just `Eject`). Used by the hook refresh flow
//! (`refresh_hook`/`reload_hook` in main.rs).

use anyhow::{bail, Result};
use protocol::control::{HookControlRequest, HookControlResponse, HOOK_CONTROL_PIPE_NAME};
use std::time::Duration;

/// A wedged or half-dead hook must not hang the reload flow.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);

async fn call(req: HookControlRequest) -> Result<HookControlResponse> {
    crate::rpc::call(
        HOOK_CONTROL_PIPE_NAME,
        protocol::control::HOOK_CONTROL_TCP_ADDR,
        CONTROL_TIMEOUT,
        req,
    )
    .await
}

/// Ask the hook to tear itself down (feature `eject` builds only). Raw errors
/// for the reload toast — no frontend slug mapping. A hook without the `eject`
/// feature has no control listener, so this surfaces as a connection error.
pub async fn eject() -> Result<()> {
    match call(HookControlRequest::Eject).await? {
        HookControlResponse::Eject(Ok(())) => Ok(()),
        HookControlResponse::Eject(Err(e)) => bail!("hook refused eject: {e}"),
    }
}
