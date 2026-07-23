//! Dev-only (feature `eject`) hook control channel.
//!
//! A SEPARATE endpoint from the Toolbox RPC (`toolbox.rs`): a hook-lifecycle
//! command must not ride in the Toolbox tool enum. Same one-request-per-
//! connection, length-delimited + bincode framing. On `Eject` we answer `Ok`,
//! flush, then begin graceful self-teardown (`crate::teardown`) so the app can
//! FreeLibrary this module and inject a rebuilt one. Never compiled into
//! release hooks.

use futures::{SinkExt, StreamExt};
use interprocess::os::windows::named_pipe::tokio::PipeListenerOptionsExt;
use interprocess::os::windows::named_pipe::{pipe_mode, PipeListenerOptions, PipeMode};
use log::{info, warn};
use protocol::control::{
    HookControlRequest, HookControlResponse, HOOK_CONTROL_PIPE_NAME, HOOK_CONTROL_TCP_ADDR,
};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::transport::{self, Transport};

/// Pure request → response mapping. Teardown is triggered by `serve` AFTER the
/// response frame is flushed, never here.
fn handle(req: HookControlRequest) -> HookControlResponse {
    match req {
        HookControlRequest::Eject => HookControlResponse::Eject(Ok(())),
    }
}

/// One connection = one request, one response, then (for Eject) teardown.
async fn serve<S>(stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let Some(Ok(frame)) = framed.next().await else {
        return;
    };
    let req = match protocol::bincode::deserialize::<HookControlRequest>(&frame) {
        Ok(req) => req,
        Err(e) => {
            warn!("control: undecodable request: {e:?}");
            return;
        }
    };
    let resp = handle(req);
    match protocol::bincode::serialize(&resp) {
        Ok(bytes) => {
            let _ = framed.send(bytes.into()).await;
        }
        Err(e) => {
            warn!("control: could not serialize response: {e:?}");
            return;
        }
    }
    // Teardown strictly AFTER the response is flushed, so the app never reads
    // from a dying listener.
    match req {
        HookControlRequest::Eject => {
            info!("control: eject requested; tearing down");
            crate::teardown::begin();
        }
    }
}

pub async fn run() {
    match transport::select_transport() {
        Transport::NamedPipe => run_pipe().await,
        Transport::Tcp => run_tcp().await,
    }
}

async fn run_pipe() {
    let listener = match PipeListenerOptions::new()
        .path(HOOK_CONTROL_PIPE_NAME)
        .mode(PipeMode::Bytes)
        .accept_remote(false)
        .create_tokio_duplex::<pipe_mode::Bytes>()
    {
        Ok(listener) => listener,
        Err(e) => {
            warn!("control: could not create pipe listener: {e:?}");
            return;
        }
    };
    info!("control: listening on {HOOK_CONTROL_PIPE_NAME}");
    loop {
        match listener.accept().await {
            Ok(stream) => {
                tokio::spawn(serve(stream));
            }
            Err(e) => warn!("control: error accepting client: {e:?}"),
        }
    }
}

// Same bind-retry rationale as the event/toolbox listeners: a taken port must
// not permanently disable control for the session.
async fn run_tcp() {
    let listener = loop {
        match tokio::net::TcpListener::bind(HOOK_CONTROL_TCP_ADDR).await {
            Ok(listener) => break listener,
            Err(e) => {
                warn!("control: could not bind {HOOK_CONTROL_TCP_ADDR}: {e:?}; retrying in 5s");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    };
    info!("control: listening on {HOOK_CONTROL_TCP_ADDR}");
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                tokio::spawn(serve(stream));
            }
            Err(e) => {
                warn!("control: error accepting client: {e:?}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one request maps to an Ok acknowledgement; the teardown side effect
    /// is exercised by `crate::teardown`'s own test.
    #[test]
    fn eject_request_is_acknowledged_ok() {
        assert_eq!(
            handle(HookControlRequest::Eject),
            HookControlResponse::Eject(Ok(()))
        );
    }
}
