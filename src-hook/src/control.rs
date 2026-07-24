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

/// Pure request → response mapping apart from the broadcast/override side
/// effects. Teardown is triggered by `serve` AFTER the response frame is
/// flushed, never here.
fn handle(tx: &crate::event::Tx, req: HookControlRequest) -> HookControlResponse {
    match req {
        HookControlRequest::Eject => HookControlResponse::Eject(Ok(())),
        HookControlRequest::BroadcastEvents(msgs) => {
            let total = msgs.len();
            let mut sent: u32 = 0;
            for m in msgs {
                // `send` errors only when there is no subscriber, so a failure
                // means "nobody listening", not "hook broken".
                if tx.send(m).is_ok() {
                    sent += 1;
                }
            }
            // This channel exists to be driven by hand, so leave a breadcrumb:
            // "I clicked Start and nothing happened" is answered here.
            info!("control: broadcasting {total} events; {sent} delivered");
            HookControlResponse::BroadcastEvents(Ok(sent))
        }
        HookControlRequest::SetHelloOverride(o) => {
            // An override is sticky per module. Install one, close the app
            // without clearing, and a later session reconnects to the still
            // mapped hook and shows an unexplained "out of date" badge — this
            // line is the only thing that would ever explain it.
            info!("control: hello override set to {o:?}");
            HookControlResponse::SetHelloOverride(crate::toolbox::set_hello_override(o))
        }
    }
}

/// One connection = one request, one response, then (for Eject) teardown.
async fn serve(tx: crate::event::Tx, stream: BoxStream) {
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
    // Captured before `req` moves into `handle`: teardown must fire only after
    // the response is flushed (below), and the request is no longer `Copy`.
    let is_eject = matches!(req, HookControlRequest::Eject);
    let resp = handle(&tx, req);
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
    if is_eject {
        info!("control: eject requested; tearing down");
        crate::teardown::begin();
    }
}

pub async fn run(tx: crate::event::Tx) {
    transport::serve_rpc(
        HOOK_CONTROL_PIPE_NAME,
        HOOK_CONTROL_TCP_ADDR,
        "control",
        move |stream| serve(tx.clone(), stream),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    use protocol::control::HelloOverride;
    use protocol::{AreaEnterEvent, Message};
    use tokio::sync::broadcast;

    #[test]
    fn eject_request_is_acknowledged_ok() {
        let (tx, _rx) = broadcast::channel::<Message>(4);
        assert_eq!(
            handle(&tx, HookControlRequest::Eject),
            HookControlResponse::Eject(Ok(()))
        );
    }

    #[test]
    fn broadcast_events_reports_the_number_delivered() {
        let (tx, _rx) = broadcast::channel::<Message>(4);
        let msgs = vec![
            Message::OnAreaEnter(AreaEnterEvent {
                last_known_quest_id: 1,
                last_known_elapsed_time_in_secs: 0,
            }),
            Message::OnAreaEnter(AreaEnterEvent {
                last_known_quest_id: 2,
                last_known_elapsed_time_in_secs: 0,
            }),
        ];
        assert_eq!(
            handle(&tx, HookControlRequest::BroadcastEvents(msgs)),
            HookControlResponse::BroadcastEvents(Ok(2))
        );
    }

    /// No subscriber means nothing was delivered — reported as 0, not an error,
    /// so the app can tell "hook fine, nobody listening" from "hook broken".
    #[test]
    fn broadcast_events_with_no_subscriber_reports_zero() {
        let (tx, rx) = broadcast::channel::<Message>(4);
        drop(rx);
        let msgs = vec![Message::OnAreaEnter(AreaEnterEvent {
            last_known_quest_id: 1,
            last_known_elapsed_time_in_secs: 0,
        })];
        assert_eq!(
            handle(&tx, HookControlRequest::BroadcastEvents(msgs)),
            HookControlResponse::BroadcastEvents(Ok(0))
        );
    }

    /// Takes the shared guard from `toolbox.rs`: this test and
    /// `hello_prefers_the_override_then_falls_back` mutate the same
    /// process-wide store and compile into the same binary under
    /// `--features eject`, so without it they race.
    #[test]
    fn set_hello_override_is_acknowledged_ok() {
        let _guard = crate::toolbox::OVERRIDE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (tx, _rx) = broadcast::channel::<Message>(4);
        let resp = handle(
            &tx,
            HookControlRequest::SetHelloOverride(Some(HelloOverride {
                hook_version: Some("9.9.9".into()),
                protocol_version: None,
                supports_eject: None,
            })),
        );
        assert_eq!(resp, HookControlResponse::SetHelloOverride(Ok(())));
        // Leave no override installed for other tests in this binary.
        handle(&tx, HookControlRequest::SetHelloOverride(None));
    }
}
