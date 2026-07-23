//! Dev-only (feature `eject`) hook control channel.
//!
//! A SEPARATE endpoint from the Toolbox RPC (`toolbox.rs`): a hook-lifecycle
//! command must not ride in the Toolbox tool enum. Same one-request-per-
//! connection, length-delimited + bincode framing. On `Eject` we answer `Ok`,
//! flush, then begin graceful self-teardown (`crate::teardown`) so the app can
//! FreeLibrary this module and inject a rebuilt one. Never compiled into
//! release hooks.

use futures::{SinkExt, StreamExt};
use log::{info, warn};
use protocol::control::{
    HookControlRequest, HookControlResponse, HOOK_CONTROL_PIPE_NAME, HOOK_CONTROL_TCP_ADDR,
};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::transport::{self, BoxStream};

/// Pure request → response mapping. Teardown is triggered by `serve` AFTER the
/// response frame is flushed, never here.
fn handle(req: HookControlRequest) -> HookControlResponse {
    match req {
        HookControlRequest::Eject => HookControlResponse::Eject(Ok(())),
    }
}

/// One connection = one request, one response, then (for Eject) teardown.
async fn serve(stream: BoxStream) {
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
    transport::serve_rpc(HOOK_CONTROL_PIPE_NAME, HOOK_CONTROL_TCP_ADDR, "control", serve).await;
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
