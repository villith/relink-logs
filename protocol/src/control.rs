//! Dev-only hook control channel: a SEPARATE request/response endpoint from
//! the Toolbox RPC (`toolbox.rs`).
//!
//! Kept apart on purpose — a hook-lifecycle command (tear down and shut down
//! so the app can FreeLibrary and re-inject a rebuilt DLL) has nothing to do
//! with the Toolbox tools' data snapshots, so it must not ride in
//! `ToolboxRequest`. Same one-request-per-connection, length-delimited +
//! bincode framing as the other channels. Only dev builds ever use it: the
//! hook serves it under its `eject` feature, the app calls it in debug
//! Windows builds. Release builds never touch these types.

use serde::{Deserialize, Serialize};

/// Windows control endpoint (duplex named pipe).
pub const HOOK_CONTROL_PIPE_NAME: &str = r"\\.\pipe\gbfr-logs-control";
/// Wine/Proton control endpoint (`TCP_PORT + 2`; toolbox uses `+ 1`).
pub const HOOK_CONTROL_TCP_PORT: u16 = super::TCP_PORT + 2;
pub const HOOK_CONTROL_TCP_ADDR: &str = "127.0.0.1:39373";

/// A dev override of the hook's `Hello` answer. A `None` field keeps the
/// hook's real value. Lets the app reach `outOfDate` against a dev hook,
/// whose real answers always match (built from the same tree, it reports the
/// expected crate version on the expected wire): overriding `hook_version`
/// alone trips the version rule, `protocol_version` the wire rule.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct HelloOverride {
    pub hook_version: Option<String>,
    pub protocol_version: Option<u32>,
    pub supports_eject: Option<bool>,
}

/// NOT `Copy`: `BroadcastEvents` carries owned messages. Also NOT
/// `PartialEq`: `protocol::Message` and its payload structs derive only
/// `Serialize, Deserialize, Debug, Clone`, so deriving it here would mean
/// adding `PartialEq` across a dozen unrelated structs in `lib.rs`.
/// Round-trip tests below compare via pattern matching instead.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum HookControlRequest {
    /// Dev-only: tear down every detour and shut down the hook runtime so the
    /// app can FreeLibrary the module and inject a rebuilt one.
    Eject,
    /// Dev-only: rebroadcast these messages verbatim on the event stream, so
    /// the app's real connect loop and parser handle them as game events.
    BroadcastEvents(Vec<crate::Message>),
    /// Dev-only: override (or, with `None`, clear) the hook's `Hello` answer.
    SetHelloOverride(Option<HelloOverride>),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum HookControlResponse {
    /// `Ok` = teardown begins after this response is sent; the pipe closing
    /// signals completion. A hook built without the `eject` feature has no
    /// control listener at all, so the app's connect simply fails — no
    /// negative variant is needed.
    Eject(Result<(), String>),
    /// The number of messages actually broadcast. `broadcast::Sender::send`
    /// fails with no subscribers, so 0 means no app is attached.
    BroadcastEvents(Result<u32, String>),
    /// `Err` carries a failure to write the hook's override store, so a debug
    /// override that did not take effect is reported rather than assumed.
    SetHelloOverride(Result<(), String>),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire is bincode both ways; a round-trip is the whole contract.
    #[test]
    fn eject_round_trips_through_bincode() {
        let req = HookControlRequest::Eject;
        let bytes = bincode::serialize(&req).unwrap();
        assert!(matches!(
            bincode::deserialize::<HookControlRequest>(&bytes).unwrap(),
            HookControlRequest::Eject
        ));

        let resp = HookControlResponse::Eject(Err("nope".into()));
        let bytes = bincode::serialize(&resp).unwrap();
        let HookControlResponse::Eject(Err(msg)) =
            bincode::deserialize::<HookControlResponse>(&bytes).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(msg, "nope");
    }

    #[test]
    fn tcp_addr_and_port_agree() {
        assert_eq!(
            HOOK_CONTROL_TCP_ADDR,
            format!("127.0.0.1:{}", HOOK_CONTROL_TCP_PORT)
        );
    }

    #[test]
    fn broadcast_events_round_trips_through_bincode() {
        let req = HookControlRequest::BroadcastEvents(vec![crate::Message::OnAreaEnter(
            crate::AreaEnterEvent {
                last_known_quest_id: 7,
                last_known_elapsed_time_in_secs: 42,
            },
        )]);
        let bytes = bincode::serialize(&req).unwrap();
        let HookControlRequest::BroadcastEvents(msgs) =
            bincode::deserialize::<HookControlRequest>(&bytes).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(msgs.len(), 1);
        let crate::Message::OnAreaEnter(e) = &msgs[0] else {
            panic!("wrong message variant");
        };
        assert_eq!(e.last_known_quest_id, 7);
        assert_eq!(e.last_known_elapsed_time_in_secs, 42);

        let resp = HookControlResponse::BroadcastEvents(Ok(3));
        let bytes = bincode::serialize(&resp).unwrap();
        let HookControlResponse::BroadcastEvents(Ok(count)) =
            bincode::deserialize::<HookControlResponse>(&bytes).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(count, 3);
    }

    #[test]
    fn hello_override_round_trips_partial_and_cleared() {
        let req = HookControlRequest::SetHelloOverride(Some(HelloOverride {
            hook_version: Some("9.9.9".into()),
            protocol_version: None,
            supports_eject: Some(false),
        }));
        let bytes = bincode::serialize(&req).unwrap();
        let HookControlRequest::SetHelloOverride(Some(o)) =
            bincode::deserialize::<HookControlRequest>(&bytes).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(o.hook_version.as_deref(), Some("9.9.9"));
        assert_eq!(o.protocol_version, None);
        assert_eq!(o.supports_eject, Some(false));

        let clear = HookControlRequest::SetHelloOverride(None);
        let bytes = bincode::serialize(&clear).unwrap();
        assert!(matches!(
            bincode::deserialize::<HookControlRequest>(&bytes).unwrap(),
            HookControlRequest::SetHelloOverride(None)
        ));
    }
}
