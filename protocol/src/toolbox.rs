//! The Toolbox RPC channel: on-demand synthesis/overmastery snapshots served
//! by the hook from inside the game process.
//!
//! Separate from the event stream on purpose: events are broadcast to every
//! client, RPC is strictly one request -> one response per CONNECTION (the
//! client connects, sends one frame, reads one frame, closes — no request
//! ids, nothing to resynchronize). Same length-delimited framing and bincode
//! payload as the event stream, so hook and app must be compiled together.
//!
//! These messages never enter the parser's on-disk log format.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Windows RPC endpoint (duplex named pipe).
pub const TOOLBOX_PIPE_NAME: &str = r"\\.\pipe\gbfr-logs-toolbox";
/// Wine/Proton RPC endpoint (`TCP_PORT + 1`).
pub const TOOLBOX_TCP_PORT: u16 = super::TCP_PORT + 1;
pub const TOOLBOX_TCP_ADDR: &str = "127.0.0.1:39372";

/// Bumped on ANY change to the RPC wire shape. The app checks it via `Hello`
/// each time the event stream connects: on Linux the deployed dinput8 proxy
/// can be older than the app until the game restarts, and a bincode mismatch
/// is silent garbage — better "restart the game" than wrong predictions.
pub const TOOLBOX_PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolboxRequest {
    Hello,
    SynthesisSnapshot,
    SynthesisSeed,
    OvermasterySnapshot,
    /// Current state of one RNG slot (< RNG_SLOT_COUNT), for staleness polls.
    OvermasterySlot(u32),
}

/// One variant per request. Payload `Err` strings are user-facing (shown by
/// the tools' error banner, unmapped slugs verbatim — see backendErrors.ts).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ToolboxResponse {
    Hello { protocol_version: u32 },
    SynthesisSnapshot(Result<SynthesisSnapshot, String>),
    SynthesisSeed(Result<SynthesisSeed, String>),
    OvermasterySnapshot(Result<OvermasterySnapshot, String>),
    OvermasterySlot(Result<u32, String>),
}

/// One sigil in the box. camelCase because the app also serializes these to
/// the frontend as JSON (bincode ignores field names, so the rename is free
/// on the wire). `record_level` is NOT skipped: it feeds the warm-up pairKey
/// and must cross the RPC wire (the frontend just ignores it).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSigil {
    /// Per-copy instance uid (map key in the sigil manager).
    pub uid: u32,
    /// The sigil's item id (GEEN_* hash) — translatable via `sigils.json`.
    pub sigil_id: u32,
    pub trait1: u32,
    pub trait1_level: u32,
    pub trait2: u32,
    pub trait2_level: u32,
    /// `record+8` of the sigil's item-config record; feeds the warm-up count.
    pub record_level: i32,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct SynthesisSnapshot {
    /// xorshift32 state of RNG slot 0x81 at snapshot time.
    pub rng_state: u32,
    /// MGR+0x2d8; part of the warm-up count.
    pub seed_counter: u32,
    /// pairKey -> times this pair-shape has been synthesized.
    pub pair_counters: HashMap<u64, u32>,
    /// rank(A)+rank(B) -> (lo, hi) level-roll weights.
    pub level_weights: HashMap<u32, (u32, u32)>,
    /// first result trait -> result sigil item id.
    pub trait_to_item: HashMap<u32, u32>,
    pub sigils: Vec<SynthesisSigil>,
}

/// The two live values every synthesis prediction depends on (beyond the
/// sigil box itself); read cheaply for staleness polling.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisSeed {
    pub rng_state: u32,
    pub seed_counter: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct OvermasterySnapshot {
    /// xorshift32 state per RNG slot at snapshot time.
    pub slots: Vec<u32>,
    /// Slot override word (0xffffffff when idle; anything else means a roll
    /// is mid-flight and predictions would race it).
    pub slot_override: u32,
    /// Character id hashes (game custom-XXHash32 of "PL####"), in roster
    /// order; a character's slot index is its position here (protagonists
    /// PL0000/PL0100 are index 0).
    pub roster: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire is bincode both ways; a round-trip through it is the whole
    /// serialization contract.
    #[test]
    fn request_and_response_round_trip_through_bincode() {
        let req = ToolboxRequest::OvermasterySlot(0x42);
        let bytes = bincode::serialize(&req).unwrap();
        assert_eq!(bincode::deserialize::<ToolboxRequest>(&bytes).unwrap(), req);

        let snap = SynthesisSnapshot {
            rng_state: 1,
            seed_counter: 2,
            pair_counters: [(3u64, 4u32)].into_iter().collect(),
            level_weights: [(5u32, (6u32, 7u32))].into_iter().collect(),
            trait_to_item: [(8u32, 9u32)].into_iter().collect(),
            sigils: vec![SynthesisSigil {
                uid: 1,
                sigil_id: 2,
                trait1: 3,
                trait1_level: 11,
                trait2: 4,
                trait2_level: 15,
                record_level: 5,
            }],
        };
        let resp = ToolboxResponse::SynthesisSnapshot(Ok(snap));
        let bytes = bincode::serialize(&resp).unwrap();
        let back: ToolboxResponse = bincode::deserialize(&bytes).unwrap();
        let ToolboxResponse::SynthesisSnapshot(Ok(back)) = back else {
            panic!("wrong variant");
        };
        // record_level MUST cross the wire (it feeds the warm-up pairKey);
        // this catches anyone re-adding the old #[serde(skip)].
        assert_eq!(back.sigils[0].record_level, 5);
    }
}
