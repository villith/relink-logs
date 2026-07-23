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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookControlRequest {
    /// Dev-only: tear down every detour and shut down the hook runtime so the
    /// app can FreeLibrary the module and inject a rebuilt one.
    Eject,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum HookControlResponse {
    /// `Ok` = teardown begins after this response is sent; the pipe closing
    /// signals completion. A hook built without the `eject` feature has no
    /// control listener at all, so the app's connect simply fails — no
    /// negative variant is needed.
    Eject(Result<(), String>),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire is bincode both ways; a round-trip is the whole contract.
    #[test]
    fn eject_round_trips_through_bincode() {
        let req = HookControlRequest::Eject;
        let bytes = bincode::serialize(&req).unwrap();
        assert_eq!(
            bincode::deserialize::<HookControlRequest>(&bytes).unwrap(),
            req
        );

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
}
