//! Client for the hook's toolbox RPC channel (one request per connection),
//! plus [`HookStatus`] — what the commands consult before calling so that
//! "game not running", "hook outdated", and "hook unreachable" each surface
//! as the right thing in the UI.
//!
//! Those three stay distinct on purpose. A handshake that cannot be DELIVERED
//! establishes nothing about the hook's version, so it reports
//! [`HookState::Unresponsive`] and is retried (and re-probed by the heartbeat
//! in main.rs) rather than latching a version verdict nobody gave us.

use anyhow::Result;
use protocol::toolbox::{OvermasterySnapshot, SynthesisSeed, SynthesisSnapshot};
use protocol::toolbox::{
    RngSlotState, ToolboxRequest, ToolboxResponse, TOOLBOX_PROTOCOL_VERSION, TOOLBOX_TCP_ADDR,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Managed Tauri state, kept current by the event-stream connect loop in
/// main.rs. All flags default to false and `hook_version` to `None`.
#[derive(Default)]
pub struct HookStatus {
    /// True while the event stream is connected (the hook is alive).
    pub connected: AtomicBool,
    /// True when the hook ANSWERED a Hello on a different protocol version.
    /// Set only by an answer — an undelivered handshake leaves it alone (see
    /// `unresponsive`), because "I could not ask" is not evidence of a
    /// version, and treating it as one is what pinned healthy hooks at
    /// "out of date" for a whole session.
    pub outdated: AtomicBool,
    /// True when the last handshake could not be delivered at all: the toolbox
    /// pipe was missing/busy, the RPC timed out, or the reply was undecodable.
    /// Distinct from `outdated` and cleared by the next answer.
    pub unresponsive: AtomicBool,
    /// Dev/refresh hook teardown in flight: the injection loop must not
    /// re-inject until the old module is ejected. See `reload_hook`/`refresh_hook`.
    pub reloading: AtomicBool,
    /// The connected hook's build version, from its Hello. None until the
    /// first successful Hello.
    pub hook_version: Mutex<Option<String>>,
    /// True when the connected hook advertised the `eject` control channel.
    pub supports_eject: AtomicBool,
    /// True when the hook DLL is not on disk where the injector looks for it
    /// (`crate::hook_dll::search_dirs`). Almost always antivirus: the DLL
    /// injects into a game process and installs inline detours, which a
    /// behavioural scanner cannot tell apart from a cheat, so it gets
    /// quarantined despite being Authenticode-signed. Kept as its own flag,
    /// not folded into `connected`, because it is a fact about the *disk* and
    /// stays true while no game is running — which is exactly when the user
    /// can still act on it.
    pub dll_missing: AtomicBool,
    /// Dev-only: hold the hook OUT of the game process after an eject, so a
    /// debug `Disconnected` stays put instead of self-healing when the
    /// injection loop reinjects a second later. Deliberately NOT read by
    /// `snapshot()` — the state stays derived, never dictated. Only
    /// `check_and_perform_hook`'s Windows injection loop honors this; there is
    /// no non-Windows injection loop to hold out of, so it's a no-op there.
    /// `Relaxed` throughout (unlike `reloading`'s `SeqCst` swap, which claims
    /// the gate against a concurrent `refresh_hook`): this flag has no
    /// companion data to publish and nothing races to set it, so ordering
    /// beyond atomicity buys nothing.
    pub dev_hold_out: AtomicBool,
}

/// The user-facing hook state, computed by `HookStatus::snapshot`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum HookState {
    /// Pipe up, Hello OK, hook speaks our wire.
    Connected,
    /// A refresh/reload is in flight.
    Reconnecting,
    /// The hook answered on another wire version. Its reported *version* is
    /// not consulted: the hook crate is versioned separately from the app so
    /// that an unchanged hook ships unchanged bytes, so a differing version
    /// string is normal and says nothing about compatibility.
    OutOfDate,
    /// Event stream up, but the hook is not answering the toolbox channel.
    /// Its version is UNKNOWN here — deliberately not folded into
    /// `OutOfDate`, which asserts something we have not been told.
    Unresponsive,
    /// The hook DLL is not on disk, so there is nothing to inject. Ranked
    /// above `Disconnected` because it is a known cause, not an absence.
    DllMissing,
    /// No hook / game not running.
    Disconnected,
}

/// What a handshake concluded. The split exists so a transport failure can
/// never masquerade as a version verdict: only `Answered` carries facts about
/// the hook, and whether those facts mean "out of date" is derived in
/// [`HookStatus::apply_hello`].
#[derive(Debug)]
pub enum HelloOutcome {
    /// The hook answered. `protocol_version` is what IT speaks, which may or
    /// may not be ours.
    Answered {
        hook_version: String,
        supports_eject: bool,
        protocol_version: u32,
    },
    /// No answer. Carries the reason purely so the log can say which — the
    /// distinction it used to lose is the whole point of this enum.
    Unreachable(String),
}

/// How many extra attempts a handshake gets before we settle on
/// `Unresponsive`. The first try is not a retry, so a full run is
/// `1 + HANDSHAKE_RETRIES` calls.
const HANDSHAKE_RETRIES: u32 = 3;

/// Backoff before handshake attempt `attempt` (0-based, counting retries
/// only), or `None` when there is nothing to gain by asking again.
///
/// Retry is for `Unreachable` alone: a hook that answered has given its
/// verdict, and re-asking cannot change it. Kept a free function so the policy
/// is unit-testable without a runtime or a game.
fn retry_delay(outcome: &HelloOutcome, attempt: u32) -> Option<Duration> {
    match outcome {
        HelloOutcome::Unreachable(_) if attempt < HANDSHAKE_RETRIES => {
            Some(Duration::from_millis(250 * 2_u64.pow(attempt)))
        }
        _ => None,
    }
}

/// How often `hook_heartbeat` (main.rs) re-probes while connected. That loop
/// is what makes a verdict self-correcting; see it for the why.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Snapshot pushed to the frontend (`hook-status` event, `get_hook_status`).
/// `PartialEq` so the heartbeat can emit only on a real change instead of
/// waking both webviews every interval.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HookStatusSnapshot {
    pub state: HookState,
    pub hook_version: Option<String>,
    pub app_version: String,
    /// Whether `refresh_hook` can act (vs. "restart the game").
    pub supports_eject: bool,
}

impl HookStatus {
    /// Fold the atomics + the app's own version into the user-facing state.
    pub fn snapshot(&self) -> HookStatusSnapshot {
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let hook_version = self.hook_version.lock().unwrap().clone();
        let supports_eject = self.supports_eject.load(Ordering::Relaxed);

        // `outdated` outranks `unresponsive`: a version verdict came from the
        // hook itself and stays true even once it stops answering, whereas
        // `unresponsive` only ever means "unknown".
        // `dll_missing` is checked only once the stream is known to be down: a
        // hook that is mapped and answering works regardless of what is on
        // disk, and telling that user their install is broken would be both
        // useless and wrong. See the snapshot tests.
        let state = if self.reloading.load(Ordering::Relaxed) {
            HookState::Reconnecting
        } else if !self.connected.load(Ordering::Relaxed) {
            if self.dll_missing.load(Ordering::Relaxed) {
                HookState::DllMissing
            } else {
                HookState::Disconnected
            }
        } else if self.outdated.load(Ordering::Relaxed) {
            HookState::OutOfDate
        } else if self.unresponsive.load(Ordering::Relaxed) {
            HookState::Unresponsive
        } else {
            HookState::Connected
        };

        HookStatusSnapshot {
            state,
            hook_version,
            app_version,
            supports_eject,
        }
    }

    /// Shared precondition for the Debug tab's hook-driving commands: a dev
    /// build (the control channel the hook serves only under its `eject`
    /// feature) and a live hook. Both slugs are mapped to friendly copy in
    /// src/backendErrors.ts. Lives here rather than in main.rs so the rule is
    /// unit-testable without a Tauri app or a running game.
    pub fn debug_precondition(&self) -> Result<(), String> {
        if !cfg!(debug_assertions) {
            return Err("debug-only".into());
        }
        if !self.connected.load(Ordering::Relaxed) {
            return Err("game-not-running".into());
        }
        Ok(())
    }

    /// Whether the injection loop must hold off (re)injecting: a hook
    /// reload/refresh is mid-flight, or a dev eject asked for the hook to stay
    /// out. Extracted from `check_and_perform_hook`'s gate so the hazard the
    /// two flags create together is an executable assertion (see the tests)
    /// rather than only a comment: `reloading` clearing does NOT reopen the
    /// gate while `dev_hold_out` is set, which is why `debug_eject_hook`
    /// refuses to set a hold during a refresh.
    pub fn injection_gated(&self) -> bool {
        self.reloading.load(Ordering::Relaxed) || self.dev_hold_out.load(Ordering::Relaxed)
    }

    /// Start-of-connection reset: a verdict belongs to the hook that produced
    /// it, so it must not survive into the next connection's pre-handshake
    /// window (up to `RPC_TIMEOUT` long, and readable there by every
    /// `get_hook_status` a page mount fires). The reported version and eject
    /// support are deliberately KEPT: they are refreshed within milliseconds
    /// by the handshake, and dropping them would flash "restart the game" at
    /// the user on every reconnect.
    pub fn on_connect(&self) {
        self.outdated.store(false, Ordering::Relaxed);
        self.unresponsive.store(false, Ordering::Relaxed);
        self.connected.store(true, Ordering::Relaxed);
    }

    /// Fold a handshake outcome in. Shared by the connect loop, the heartbeat
    /// and the dev re-handshake so no path can drift from the others.
    ///
    /// Only an ANSWER writes `hook_version`/`supports_eject`. An undelivered
    /// handshake leaves every known fact standing and reports only what it
    /// actually established: that the hook is not answering.
    pub fn apply_hello(&self, outcome: HelloOutcome) {
        let (hook_version, supports_eject, protocol_version) = match outcome {
            HelloOutcome::Answered {
                hook_version,
                supports_eject,
                protocol_version,
            } => (hook_version, supports_eject, protocol_version),
            HelloOutcome::Unreachable(why) => {
                // The one line that used to be missing entirely: without it
                // there is no way, live or after the fact, to tell a real
                // version mismatch from a pipe that was not up yet.
                log::warn!("hook handshake undeliverable ({why}); version left unknown");
                self.unresponsive.store(true, Ordering::Relaxed);
                return;
            }
        };

        let outdated = protocol_version != TOOLBOX_PROTOCOL_VERSION;
        if outdated {
            log::warn!(
                "hook toolbox protocol {protocol_version} != ours {TOOLBOX_PROTOCOL_VERSION} \
                 (hook {hook_version}): the mapped hook is out of date"
            );
        }

        self.outdated.store(outdated, Ordering::Relaxed);
        self.unresponsive.store(false, Ordering::Relaxed);
        *self.hook_version.lock().unwrap() = Some(hook_version);
        self.supports_eject.store(supports_eject, Ordering::Relaxed);
    }
}

/// A wedged hook (or frozen game) must not hang a Tauri command.
const RPC_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn call(req: ToolboxRequest) -> Result<ToolboxResponse> {
    crate::rpc::call(
        protocol::toolbox::TOOLBOX_PIPE_NAME,
        TOOLBOX_TCP_ADDR,
        RPC_TIMEOUT,
        req,
    )
    .await
}

/// Run one handshake. Every failure mode reports WHY, so the caller can retry
/// the transient ones and the log can name the cause.
pub async fn hello() -> HelloOutcome {
    match call(ToolboxRequest::Hello).await {
        Ok(ToolboxResponse::Hello {
            protocol_version,
            hook_version,
            supports_eject,
        }) => HelloOutcome::Answered {
            hook_version,
            supports_eject,
            protocol_version,
        },
        // A different variant back is a broken peer, not an old one: it
        // answered the wrong question, so we learned nothing about its version.
        Ok(other) => HelloOutcome::Unreachable(format!("unexpected reply {other:?}")),
        Err(e) => HelloOutcome::Unreachable(format!("{e:#}")),
    }
}

/// Handshake with bounded retry, then fold the result in.
///
/// The retry is the difference between "a toolbox pipe that was not up yet
/// costs one mislabelled session" and "costs 250ms".
pub async fn handshake(hook: &HookStatus) {
    for attempt in 0.. {
        let outcome = hello().await;
        let Some(delay) = retry_delay(&outcome, attempt) else {
            hook.apply_hello(outcome);
            return;
        };
        log::info!(
            "hook handshake attempt {} undeliverable; retrying in {delay:?}",
            attempt + 1
        );
        tokio::time::sleep(delay).await;
    }
}

/// Shared precondition for every toolbox command. `Ok(None)` = the event
/// stream is down, which the tools present as "game not running". The two
/// error slugs are mapped to friendly copy in src/backendErrors.ts; remote
/// error strings (e.g. "still on title screen?") pass through verbatim.
async fn request(
    hook: &HookStatus,
    req: ToolboxRequest,
) -> Result<Option<ToolboxResponse>, String> {
    if !hook.connected.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if hook.outdated.load(Ordering::Relaxed) {
        return Err("hook-outdated".into());
    }
    map_transport(call(req).await)
}

/// Map one transport result onto the slug the UI switches on.
///
/// Split out of [`request`] so it can be tested without a pipe: a developer
/// with the game open has a hook that ANSWERS the toolbox channel, so driving
/// this through the real transport asserted the absence of the very thing the
/// machine was running.
fn map_transport(result: Result<ToolboxResponse>) -> Result<Option<ToolboxResponse>, String> {
    match result {
        Ok(resp) => Ok(Some(resp)),
        Err(e) => {
            log::warn!("toolbox rpc failed: {e:?}");
            Err("hook-unreachable".into())
        }
    }
}

pub async fn synthesis_snapshot(hook: &HookStatus) -> Result<Option<SynthesisSnapshot>, String> {
    match request(hook, ToolboxRequest::SynthesisSnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn synthesis_seed(hook: &HookStatus) -> Result<Option<SynthesisSeed>, String> {
    match request(hook, ToolboxRequest::SynthesisSeed).await? {
        None => Ok(None),
        Some(ToolboxResponse::SynthesisSeed(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

pub async fn overmastery_snapshot(
    hook: &HookStatus,
) -> Result<Option<OvermasterySnapshot>, String> {
    match request(hook, ToolboxRequest::OvermasterySnapshot).await? {
        None => Ok(None),
        Some(ToolboxResponse::OvermasterySnapshot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

/// One RNG slot's live state. Serves the transmarvel prediction (which wants
/// both fields) and every tool's staleness poll (which wants only `state`).
pub async fn rng_slot(hook: &HookStatus, slot: u32) -> Result<Option<RngSlotState>, String> {
    match request(hook, ToolboxRequest::RngSlot(slot)).await? {
        None => Ok(None),
        Some(ToolboxResponse::RngSlot(r)) => r.map(Some),
        Some(other) => Err(format!("unexpected toolbox response {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gating rules the frontend copy depends on, without any live hook.
    #[tokio::test]
    async fn disconnected_hook_reads_as_game_not_running() {
        let hook = HookStatus::default();
        assert_eq!(synthesis_snapshot(&hook).await, Ok(None));
    }

    #[tokio::test]
    async fn outdated_hook_maps_to_its_slug() {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        hook.outdated.store(true, Ordering::Relaxed);
        assert_eq!(
            synthesis_snapshot(&hook).await,
            Err("hook-outdated".to_string())
        );
    }

    /// connected + current but the request does not come back → the unreachable
    /// slug, never a hang and never a version verdict.
    ///
    /// Asserted on the mapping rather than through the real pipe: the old form
    /// called `synthesis_snapshot` and depended on nothing listening, so it
    /// failed on every local run made with the game open — the one machine
    /// state where a hook is guaranteed to answer.
    #[test]
    fn unreachable_transport_maps_to_its_slug() {
        assert_eq!(
            map_transport(Err(anyhow::anyhow!("toolbox pipe busy"))).err(),
            Some("hook-unreachable".to_string())
        );
    }

    /// The other half of the same mapping: an answer is passed straight
    /// through, so a reachable hook is never reported as unreachable.
    #[test]
    fn answered_transport_passes_through() {
        let answered = map_transport(Ok(ToolboxResponse::Hello {
            protocol_version: TOOLBOX_PROTOCOL_VERSION,
            hook_version: "test".into(),
            supports_eject: false,
        }));
        assert!(matches!(answered, Ok(Some(ToolboxResponse::Hello { .. }))));
    }

    fn connected_hook(hook_version: Option<&str>, supports_eject: bool) -> HookStatus {
        let hook = HookStatus::default();
        hook.connected.store(true, Ordering::Relaxed);
        *hook.hook_version.lock().unwrap() = hook_version.map(String::from);
        hook.supports_eject.store(supports_eject, Ordering::Relaxed);
        hook
    }

    #[test]
    fn snapshot_disconnected_when_pipe_down() {
        assert_eq!(
            HookStatus::default().snapshot().state,
            HookState::Disconnected
        );
    }

    /// Antivirus quarantining hook.dll used to be indistinguishable from "the
    /// game isn't running": the inject failed into a debug log and the badge
    /// said "No game found". It is a distinct, actionable fact and says so.
    #[test]
    fn snapshot_dll_missing_when_the_file_is_gone() {
        let hook = HookStatus::default();
        hook.dll_missing.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::DllMissing);
    }

    /// A live hook is a live hook. The DLL can vanish from disk *after* it was
    /// injected (a mid-session quarantine, or an update replacing it), and the
    /// meter keeps working off the mapped module — so the badge must not cry
    /// broken at someone whose session is fine. It surfaces on the next launch,
    /// when it is actually true.
    #[test]
    fn snapshot_prefers_a_live_hook_over_a_missing_file() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.dll_missing.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    /// A teardown in flight has deleted nothing; `Reconnecting` still outranks.
    #[test]
    fn snapshot_reconnecting_outranks_dll_missing() {
        let hook = HookStatus::default();
        hook.dll_missing.store(true, Ordering::Relaxed);
        hook.reloading.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Reconnecting);
    }

    #[test]
    fn snapshot_reconnecting_takes_precedence() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.reloading.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Reconnecting);
    }

    #[test]
    fn snapshot_connected_when_versions_match() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    /// The hook's reported version is INFORMATIONAL — it names the hook crate,
    /// which is versioned independently of the app so that a release that did
    /// not touch `src-hook/` ships a byte-identical `hook.dll`. Compatibility
    /// is decided by the wire fingerprint alone (`outdated`), so a hook whose
    /// version merely differs from the app's is a healthy hook.
    ///
    /// The deleted `snapshot_out_of_date_on_version_difference` asserted the
    /// opposite. That rule rotated the DLL's hash on every release — every
    /// published build a zero-prevalence file to antivirus ML — while catching
    /// nothing the fingerprint does not catch.
    #[test]
    fn snapshot_connected_when_only_the_reported_version_differs() {
        let hook = connected_hook(Some("0.0.1-old"), true);
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    #[test]
    fn snapshot_out_of_date_on_protocol_mismatch() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.outdated.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);
    }

    /// A hook that answered, either on our protocol version or on another one.
    fn answered(ok: bool) -> HelloOutcome {
        HelloOutcome::Answered {
            hook_version: env!("CARGO_PKG_VERSION").to_string(),
            supports_eject: true,
            protocol_version: if ok {
                TOOLBOX_PROTOCOL_VERSION
            } else {
                TOOLBOX_PROTOCOL_VERSION + 1
            },
        }
    }

    #[test]
    fn protocol_mismatch_reads_out_of_date() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.apply_hello(answered(false));
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);
    }

    #[test]
    fn apply_hello_matching_version_reads_connected() {
        let hook = connected_hook(None, false);
        hook.apply_hello(answered(true));
        let snapshot = hook.snapshot();
        assert_eq!(snapshot.state, HookState::Connected);
        assert_eq!(
            snapshot.hook_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert!(snapshot.supports_eject);
    }

    /// The bug this whole outcome split exists for: a handshake that could not
    /// be DELIVERED says nothing about the hook's version, so it must not
    /// claim the hook is out of date.
    #[test]
    fn an_undeliverable_handshake_is_not_an_out_of_date_hook() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.apply_hello(HelloOutcome::Unreachable("os error 2".into()));
        assert_eq!(hook.snapshot().state, HookState::Unresponsive);
    }

    /// ...and it must not destroy what the last real answer told us. Wiping
    /// `supports_eject` here is what used to hide the Refresh button (and make
    /// `refresh_hook` refuse) in exactly the case where the state was bogus.
    #[test]
    fn an_undeliverable_handshake_keeps_the_last_known_facts() {
        let hook = connected_hook(None, false);
        hook.apply_hello(answered(true));
        hook.apply_hello(HelloOutcome::Unreachable("rpc timed out".into()));

        let snapshot = hook.snapshot();
        assert_eq!(
            snapshot.hook_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert!(snapshot.supports_eject);
    }

    /// The un-latching contract the heartbeat depends on: whatever a previous
    /// handshake concluded, a later successful one fully clears it.
    #[test]
    fn a_later_successful_hello_clears_both_verdicts() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);

        hook.apply_hello(answered(false));
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);
        hook.apply_hello(HelloOutcome::Unreachable("os error 2".into()));
        assert_eq!(hook.snapshot().state, HookState::OutOfDate);

        hook.apply_hello(answered(true));
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    /// A verdict belongs to the connection that produced it. Carrying one over
    /// leaves the pre-handshake window of the NEXT connection reporting the
    /// last hook's answer — which `get_hook_status` (called on every page
    /// mount) will happily paint.
    #[test]
    fn a_new_connection_starts_without_the_previous_verdict() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.apply_hello(answered(false));
        hook.apply_hello(HelloOutcome::Unreachable("os error 2".into()));

        hook.on_connect();
        assert_eq!(hook.snapshot().state, HookState::Connected);
    }

    /// Retry is for the transient outcome only: a hook that ANSWERED has given
    /// its verdict, and asking again cannot change it.
    #[test]
    fn only_an_undeliverable_handshake_is_retried() {
        assert!(retry_delay(&HelloOutcome::Unreachable("x".into()), 0).is_some());
        assert!(retry_delay(&answered(true), 0).is_none());
        assert!(retry_delay(&answered(false), 0).is_none());
    }

    /// ...and retry is bounded, so a genuinely dead channel settles on
    /// `Unresponsive` instead of probing forever.
    #[test]
    fn retries_are_bounded() {
        let unreachable = HelloOutcome::Unreachable("x".into());
        assert!(retry_delay(&unreachable, HANDSHAKE_RETRIES - 1).is_some());
        assert!(retry_delay(&unreachable, HANDSHAKE_RETRIES).is_none());
    }

    /// The Debug tab's hook-driving commands all want the same two things.
    /// Tests build with `debug_assertions` on, so the dev-build half is
    /// satisfied here and the `connected` half is what's under test.
    #[cfg(debug_assertions)]
    #[test]
    fn debug_precondition_requires_a_live_hook() {
        assert_eq!(
            HookStatus::default().debug_precondition(),
            Err("game-not-running".to_string())
        );
        assert_eq!(connected_hook(None, false).debug_precondition(), Ok(()));
    }

    /// The release half of the same precondition: these commands drive the
    /// hook over a channel only dev builds serve, so a release build refuses
    /// before it ever looks at `connected`.
    #[cfg(not(debug_assertions))]
    #[test]
    fn debug_precondition_refuses_release_builds() {
        assert_eq!(
            connected_hook(None, false).debug_precondition(),
            Err("debug-only".to_string())
        );
    }

    /// The injection loop's gate: either flag alone holds it.
    #[test]
    fn injection_gated_on_either_flag() {
        let hook = HookStatus::default();
        assert!(!hook.injection_gated());

        hook.reloading.store(true, Ordering::Relaxed);
        assert!(hook.injection_gated());

        hook.dev_hold_out.store(true, Ordering::Relaxed);
        assert!(hook.injection_gated());

        hook.reloading.store(false, Ordering::Relaxed);
        assert!(hook.injection_gated());
    }

    /// The interleave `debug_eject_hook`'s reloading check exists to prevent:
    /// a hold set mid-refresh survives the refresh's clear, so when
    /// `reloading` drops the gate is STILL closed and the injection loop
    /// waits forever. Pinned as an assertion, not just a comment.
    #[test]
    fn a_hold_set_during_a_refresh_outlives_it() {
        let hook = HookStatus::default();
        hook.reloading.store(true, Ordering::Relaxed);
        hook.dev_hold_out.store(true, Ordering::Relaxed);

        // The refresh finishes and clears its own flag...
        hook.reloading.store(false, Ordering::SeqCst);

        // ...and the loop is still gated, with nothing left to clear it.
        assert!(hook.injection_gated());
    }

    /// `dev_hold_out` keeps an ejected hook OUT of the process; it must not
    /// colour the reported state, which stays derived from the real signals.
    #[test]
    fn dev_hold_out_does_not_change_the_reported_state() {
        let hook = connected_hook(Some(env!("CARGO_PKG_VERSION")), true);
        hook.dev_hold_out.store(true, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Connected);

        hook.connected.store(false, Ordering::Relaxed);
        assert_eq!(hook.snapshot().state, HookState::Disconnected);
    }
}
