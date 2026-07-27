//! Toolbox RPC server: synthesis/overmastery snapshots read in-process and
//! served on demand — needs no privileges on either platform (the Linux app
//! cannot ReadProcessMemory a Wine process; this replaces that path).
//!
//! One request per connection: read one frame, answer one frame, done. Runs
//! entirely on the hook's tokio runtime — never on a game thread. The walks
//! happen at menu cadence (a user sitting in the synthesis/meditation
//! screen), so per-read SEH guard overhead is irrelevant; what matters is
//! that a torn pointer becomes an error response instead of a game crash.
//!
//! Also holds the dev `Hello` override store: state written by the
//! feature-gated control channel (`control.rs`) but read here unconditionally.

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use game_reader::MemRead;
use log::warn;
use pelite::pe64::PeView;
use protocol::control::HelloOverride;
use protocol::toolbox::{
    ToolboxRequest, ToolboxResponse, TOOLBOX_PIPE_NAME, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use std::sync::{OnceLock, RwLock};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::hooks::diag::readable;
use crate::transport::{self, BoxStream};

/// Dev `Hello` override. Written only by the feature-gated control channel, so
/// a release hook leaves it `None` for the life of the process.
static HELLO_OVERRIDE: RwLock<Option<HelloOverride>> = RwLock::new(None);

/// Install (or, with `None`, clear) the dev `Hello` override. A poisoned lock
/// is reported rather than swallowed: a debug tool that silently fails to apply
/// an override leaves the operator chasing a state the hook never entered.
/// (The READ path deliberately does the opposite and falls back to the real
/// values — a `Hello` must always answer, and the truth is the safe answer.)
///
/// The store stays compiled without the `eject` feature so its tests run under
/// a plain `cargo test -p hook`; that build has no writer, and `hook` is a
/// `cdylib`, so `pub` does not save it from `dead_code`.
#[cfg_attr(not(feature = "eject"), allow(dead_code))]
pub fn set_hello_override(o: Option<HelloOverride>) -> Result<(), String> {
    let mut guard = HELLO_OVERRIDE
        .write()
        .map_err(|_| "hello override lock poisoned".to_string())?;
    *guard = o;
    Ok(())
}

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
    /// The RNG slot array, resolved ONCE and shared by every RNG-backed tool
    /// — a game patch that moves it has one failure site, not one per tool.
    rng: u32,
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
                rng: game_reader::resolve_rng_rva(view).map_err(|e| e.to_string())?,
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
        ToolboxRequest::Hello => {
            let o = HELLO_OVERRIDE.read().ok().and_then(|g| (*g).clone());
            ToolboxResponse::Hello {
                protocol_version: o
                    .as_ref()
                    .and_then(|o| o.protocol_version)
                    .unwrap_or(TOOLBOX_PROTOCOL_VERSION),
                hook_version: o
                    .as_ref()
                    .and_then(|o| o.hook_version.clone())
                    .unwrap_or_else(|| env!("HOOK_VERSION").to_string()),
                supports_eject: o
                    .as_ref()
                    .and_then(|o| o.supports_eject)
                    .unwrap_or(cfg!(feature = "eject")),
            }
        }
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
                    game_reader::overmastery::take_snapshot(
                        &InProcMem,
                        g.base,
                        g.rng,
                        g.overmastery,
                    )
                })
            }))
        }
        ToolboxRequest::RngSlot(slot) => ToolboxResponse::RngSlot(globals().and_then(|g| {
            guarded(|| game_reader::read_rng_slot(&InProcMem, g.base, g.rng, slot))
        })),
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

/// `ready` fires once the channel is connectable — the event server waits on
/// it so the app can never accept the event stream (and immediately fire its
/// `Hello`) before this listener exists.
pub async fn run(ready: tokio::sync::oneshot::Sender<()>) {
    transport::serve_rpc(
        TOOLBOX_PIPE_NAME,
        TOOLBOX_TCP_ADDR,
        "toolbox",
        serve,
        Some(ready),
    )
    .await;
}

/// Every test that touches `HELLO_OVERRIDE` takes this: the store is
/// process-wide and the test runner is parallel. Callers recover from
/// poisoning (`unwrap_or_else(|e| e.into_inner())`) so one failing test does
/// not cascade into unrelated ones.
#[cfg(test)]
pub(crate) static OVERRIDE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::toolbox::{ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION};

    /// One test, not three: they share a process-wide static, so separate
    /// tests would race under the parallel runner. The guard also serializes
    /// against Task 3's control-channel test, which lives in the same binary
    /// under `--features eject` and mutates the same store.
    #[test]
    fn hello_prefers_the_override_then_falls_back() {
        let _guard = OVERRIDE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        set_hello_override(Some(HelloOverride {
            hook_version: Some("9.9.9".into()),
            protocol_version: Some(999),
            supports_eject: Some(false),
        }))
        .unwrap();
        let ToolboxResponse::Hello {
            protocol_version,
            hook_version,
            supports_eject,
        } = handle_request(ToolboxRequest::Hello)
        else {
            panic!("expected Hello variant");
        };
        assert_eq!(protocol_version, 999);
        assert_eq!(hook_version, "9.9.9");
        assert!(!supports_eject);

        // A None field keeps the real value.
        set_hello_override(Some(HelloOverride {
            hook_version: None,
            protocol_version: None,
            supports_eject: None,
        }))
        .unwrap();
        let ToolboxResponse::Hello {
            protocol_version,
            hook_version,
            supports_eject,
        } = handle_request(ToolboxRequest::Hello)
        else {
            panic!("expected Hello variant");
        };
        assert_eq!(protocol_version, TOOLBOX_PROTOCOL_VERSION);
        assert_eq!(hook_version, env!("HOOK_VERSION"));
        // The deleted `hello_reports_version_and_eject_support` test owned this
        // assertion. Without it the field is unpinned: the override block above
        // sets `Some(false)` and the real value is ALSO false under a plain
        // `cargo test -p hook`, so that assertion alone proves nothing.
        assert_eq!(supports_eject, cfg!(feature = "eject"));

        // Clearing restores everything.
        set_hello_override(None).unwrap();
        let ToolboxResponse::Hello { hook_version, .. } = handle_request(ToolboxRequest::Hello)
        else {
            panic!("expected Hello variant");
        };
        assert_eq!(hook_version, env!("HOOK_VERSION"));
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

    /// Same contract for the RNG-slot arm (the read behind both the
    /// transmarvel prediction and every staleness poll): sigscan failure in
    /// the test binary must become an error response, never a panic.
    #[test]
    fn rng_slot_against_a_non_game_binary_is_an_error_response() {
        let ToolboxResponse::RngSlot(result) =
            handle_request(ToolboxRequest::RngSlot(game_reader::transmarvel::TM_SLOT))
        else {
            panic!("wrong variant");
        };
        assert!(result.is_err());
    }
}
