//! Toolbox RPC server: synthesis/overmastery snapshots read in-process and
//! served on demand — needs no privileges on either platform (the Linux app
//! cannot ReadProcessMemory a Wine process; this replaces that path).
//!
//! One request per connection: read one frame, answer one frame, done. Runs
//! entirely on the hook's tokio runtime — never on a game thread. The walks
//! happen at menu cadence (a user sitting in the synthesis/meditation
//! screen), so per-read SEH guard overhead is irrelevant; what matters is
//! that a torn pointer becomes an error response instead of a game crash.

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use game_reader::MemRead;
use log::warn;
use pelite::pe64::PeView;
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PIPE_NAME, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use std::sync::OnceLock;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::hooks::diag::readable;
use crate::transport::{self, BoxStream};

/// Guarded in-process reads: chasing a torn map pointer unguarded would
/// crash the game, so every read SEH-probes first (see `diag::readable`).
struct InProcMem;

impl MemRead for InProcMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()> {
        if !readable(addr as usize, buf.len()) {
            anyhow::bail!("unreadable memory at {addr:#x} ({} bytes)", buf.len());
        }
        unsafe { std::ptr::copy_nonoverlapping(addr as *const u8, buf.as_mut_ptr(), buf.len()) };
        Ok(())
    }
}

struct Globals {
    base: u64,
    synthesis: game_reader::synthesis::SynthesisRvas,
    overmastery: game_reader::overmastery::OvermasteryRvas,
}

/// Resolve the toolbox globals by sigscanning the loaded exe image, once per
/// process lifetime. A failure (game patch changed the signatures) is cached
/// too — rescanning the same image cannot start succeeding.
fn globals() -> Result<&'static Globals, String> {
    static GLOBALS: OnceLock<Result<Globals, String>> = OnceLock::new();
    GLOBALS
        .get_or_init(|| {
            let module = unsafe {
                windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
            }
            .map_err(|e| format!("GetModuleHandleW: {e:?}"))?;
            let base = module.0 as u64;
            let view = unsafe { PeView::module(base as *const u8) };
            Ok(Globals {
                base,
                synthesis: game_reader::synthesis::resolve_rvas(view)
                    .map_err(|e| e.to_string())?,
                overmastery: game_reader::overmastery::resolve_rvas(view)
                    .map_err(|e| e.to_string())?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Run a read under catch_unwind: a walker panic must degrade to an error
/// response, never unwind across the listener (and never reach game code).
fn guarded<T>(f: impl FnOnce() -> Result<T>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("toolbox read panicked (see hook log)".to_string()),
    }
}

fn handle_request(req: ToolboxRequest) -> ToolboxResponse {
    match req {
        ToolboxRequest::Hello => ToolboxResponse::Hello {
            protocol_version: TOOLBOX_PROTOCOL_VERSION,
            hook_version: env!("HOOK_VERSION").to_string(),
            supports_eject: cfg!(feature = "eject"),
        },
        ToolboxRequest::SynthesisSnapshot => ToolboxResponse::SynthesisSnapshot(
            globals().and_then(|g| {
                guarded(|| game_reader::synthesis::take_snapshot(&InProcMem, g.base, g.synthesis))
            }),
        ),
        ToolboxRequest::SynthesisSeed => ToolboxResponse::SynthesisSeed(globals().and_then(|g| {
            guarded(|| game_reader::synthesis::take_seed_state(&InProcMem, g.base, g.synthesis))
        })),
        ToolboxRequest::OvermasterySnapshot => {
            ToolboxResponse::OvermasterySnapshot(globals().and_then(|g| {
                guarded(|| {
                    game_reader::overmastery::take_snapshot(&InProcMem, g.base, g.overmastery)
                })
            }))
        }
        ToolboxRequest::OvermasterySlot(slot) => {
            ToolboxResponse::OvermasterySlot(globals().and_then(|g| {
                guarded(|| {
                    game_reader::overmastery::take_slot_state(
                        &InProcMem,
                        g.base,
                        g.overmastery,
                        slot,
                    )
                })
            }))
        }
    }
}

/// One connection = one request, one response.
async fn serve(stream: BoxStream) {
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let Some(Ok(frame)) = framed.next().await else {
        return;
    };
    let req = match protocol::bincode::deserialize::<ToolboxRequest>(&frame) {
        Ok(req) => req,
        Err(e) => {
            warn!("toolbox: undecodable request: {e:?}");
            return;
        }
    };
    let resp = handle_request(req);
    match protocol::bincode::serialize(&resp) {
        Ok(bytes) => {
            let _ = framed.send(bytes.into()).await;
        }
        Err(e) => warn!("toolbox: could not serialize response: {e:?}"),
    }
}

pub async fn run() {
    transport::serve_rpc(TOOLBOX_PIPE_NAME, TOOLBOX_TCP_ADDR, "toolbox", serve).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::toolbox::{ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION};

    #[test]
    fn hello_reports_version_and_eject_support() {
        let ToolboxResponse::Hello {
            protocol_version,
            hook_version,
            supports_eject,
        } = handle_request(ToolboxRequest::Hello)
        else {
            panic!("expected Hello variant");
        };
        assert_eq!(protocol_version, TOOLBOX_PROTOCOL_VERSION);
        // env!("HOOK_VERSION") is set by build.rs; in `cargo test` with no
        // HOOK_VERSION env it is the dev sentinel.
        assert_eq!(hook_version, env!("HOOK_VERSION"));
        // `eject` feature is off under plain `cargo test -p hook`.
        assert_eq!(supports_eject, cfg!(feature = "eject"));
    }

    /// In the test binary the sigscan finds nothing — the handler must turn
    /// that into an error RESPONSE, never a panic or unwind.
    #[test]
    fn snapshot_against_a_non_game_binary_is_an_error_response() {
        let ToolboxResponse::SynthesisSnapshot(result) =
            handle_request(ToolboxRequest::SynthesisSnapshot)
        else {
            panic!("wrong variant");
        };
        assert!(result.is_err());
    }
}
