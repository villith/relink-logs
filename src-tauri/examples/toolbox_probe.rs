//! Live A/B harness for the toolbox RPC channel: takes each snapshot BOTH
//! ways — via the hook's RPC listener (production path) and via
//! ReadProcessMemory (independent ground truth) — and reports whether they
//! agree. Run as admin with the game running and the hook injected:
//!
//!   cargo run -p gbfr-logs --example toolbox_probe
//!
//! Set GBFR_LOGS_FORCE_TCP=1 to exercise the TCP path (what Linux uses).
//! The two reads are not atomic — a sigil-box or RNG change between them is
//! a real difference, so run it while idling in a menu.

use anyhow::{bail, Result};
use gbfr_logs::{game_mem, toolbox_rpc};
use protocol::toolbox::{ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    match toolbox_rpc::call(ToolboxRequest::Hello).await? {
        ToolboxResponse::Hello { protocol_version, .. } => {
            println!(
                "hello: hook v{protocol_version}, app v{TOOLBOX_PROTOCOL_VERSION} => {}",
                if protocol_version == TOOLBOX_PROTOCOL_VERSION { "OK" } else { "MISMATCH" }
            );
        }
        other => bail!("unexpected hello response: {other:?}"),
    }

    let rpc_synth = match toolbox_rpc::call(ToolboxRequest::SynthesisSnapshot).await? {
        ToolboxResponse::SynthesisSnapshot(r) => r,
        other => bail!("unexpected response: {other:?}"),
    };
    let rpm_synth = game_mem::rpm_synthesis_snapshot();
    match (&rpc_synth, &rpm_synth) {
        (Ok(a), Ok(Some(b))) => {
            println!(
                "synthesis: rpc {} sigils (rng {:#x}, seed {}), rpm {} sigils (rng {:#x}, seed {}) => {}",
                a.sigils.len(), a.rng_state, a.seed_counter,
                b.sigils.len(), b.rng_state, b.seed_counter,
                if a == b { "IDENTICAL" } else { "DIFFER (re-run while idle in a menu)" }
            );
        }
        _ => println!("synthesis: rpc={rpc_synth:?}\n           rpm={rpm_synth:?}"),
    }

    let rpc_om = match toolbox_rpc::call(ToolboxRequest::OvermasterySnapshot).await? {
        ToolboxResponse::OvermasterySnapshot(r) => r,
        other => bail!("unexpected response: {other:?}"),
    };
    let rpm_om = game_mem::rpm_overmastery_snapshot();
    match (&rpc_om, &rpm_om) {
        (Ok(a), Ok(Some(b))) => {
            println!(
                "overmastery: rpc {} roster / override {:#x}, rpm {} roster / override {:#x} => {}",
                a.roster.len(), a.slot_override, b.roster.len(), b.slot_override,
                if a == b { "IDENTICAL" } else { "DIFFER (RNG may have ticked; re-run)" }
            );
        }
        _ => println!("overmastery: rpc={rpc_om:?}\n             rpm={rpm_om:?}"),
    }

    Ok(())
}
