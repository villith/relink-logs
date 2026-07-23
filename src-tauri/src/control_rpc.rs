//! Dev-only client for the hook's control channel (feature `eject` hooks).
//!
//! Separate from `toolbox_rpc`: the control channel carries hook-lifecycle
//! commands (currently just `Eject`), not Toolbox tool data. Compiled only in
//! debug Windows builds — the reload flow that uses it (`reload_hook` in
//! main.rs) is itself dev-only.

use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use protocol::control::{HookControlRequest, HookControlResponse, HOOK_CONTROL_PIPE_NAME};
use std::time::Duration;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

/// A wedged or half-dead hook must not hang the reload flow.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);

async fn exchange<S>(stream: S, req: &HookControlRequest) -> Result<HookControlResponse>
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
        None => bail!("control channel closed before responding"),
    }
}

/// Same transport selection as the toolbox client: pipe on native Windows,
/// TCP under GBFR_LOGS_FORCE_TCP=1 (so the reload path matches the hook's own
/// `select_transport`).
async fn call_inner(req: &HookControlRequest) -> Result<HookControlResponse> {
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};
        let stream =
            DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(HOOK_CONTROL_PIPE_NAME).await?;
        return exchange(stream, req).await;
    }
    let stream = tokio::net::TcpStream::connect(protocol::control::HOOK_CONTROL_TCP_ADDR).await?;
    exchange(stream, req).await
}

async fn call(req: HookControlRequest) -> Result<HookControlResponse> {
    tokio::time::timeout(CONTROL_TIMEOUT, call_inner(&req))
        .await
        .context("control rpc timed out")?
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
