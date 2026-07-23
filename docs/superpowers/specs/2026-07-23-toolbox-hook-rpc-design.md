# Toolbox via Hook RPC (Windows + Linux)

**Date:** 2026-07-23
**Status:** Approved

## Goal

Serve the two Toolbox tools (Synthesis Helper, Overmastery Predictor) from
inside the injected hook over a new request/response channel, on both
platforms. This unblocks the tools on Linux — reading a Wine process from
outside requires ptrace privileges we refuse to ask users for — and removes
the out-of-process `ReadProcessMemory` path on Windows. The Linux-support
spec (2026-07-22) descoped this and named this design as the follow-up.

## Non-goals

- Changes to the prediction/search engines, baked tables, or Toolbox UI
  logic. Only the snapshot source changes.
- Serving any other data over the RPC channel (equipment, encounter state).
  The event stream remains the only push channel.
- A Windows `ReadProcessMemory` fallback in the app. The production path is
  hook-only on both platforms (decided 2026-07-23); RPM survives only inside
  the diag probes.

## Background

Today `src-tauri/src/game_mem.rs` opens the game with
`OpenProcess`/`ReadProcessMemory`, sigscans the on-disk exe (~120 MB read)
for globals, and the two `snapshot.rs` files walk game structures from
outside the process. All of it is `#[cfg(windows)]`; the six Toolbox Tauri
commands return "windows-only" errors elsewhere, and the frontend hides the
pages on Linux.

The entire memory-read surface is small:

- **Synthesis** (`synthesis/snapshot.rs`): resolve 2 globals, walk five MSVC
  `unordered_map`s (bounded at 500k entries), plus a 2-word seed-identity
  read for 5-second staleness polling.
- **Overmastery** (`overmastery/snapshot.rs`): resolve 2 globals, read the
  0x83-slot RNG array + override word, walk one bounded roster vector, plus
  a single-u32 staleness read.

The hook already sigscans its own in-memory image with pelite
(`PeView::module` in `src-hook/src/process.rs`) using the same pattern
syntax and `'` cursor captures the Toolbox signatures use, and already has a
guarded-read probe (`readable()` via SEH `IsBadReadPtr` in
`src-hook/src/hooks/diag.rs`).

## Design

### Transport: dedicated RPC channel

The hook opens a second listener next to the event server, chosen by the
existing `transport::select_transport()`:

- Native Windows: duplex named pipe `\\.\pipe\gbfr-logs-toolbox`
- Wine/Proton or `GBFR_LOGS_FORCE_TCP=1`: TCP `127.0.0.1:39372`
  (`TCP_PORT + 1`)

**One request per connection:** the app connects, sends one request frame,
reads one response frame, and closes. At a 5-second polling cadence on
localhost this costs nothing, and it eliminates request ids, response
routing, and long-lived connection state. Framing and payload match the
event stream: length-delimited frames carrying bincode.

The event stream is untouched. Its broadcast-to-all-clients model fits
request/response badly, and keeping the combat-critical path unmodified
limits risk.

The app applies a ~2-second timeout per call so a wedged hook cannot hang a
Tauri command. Bind failures on the TCP port retry, mirroring the event
listener.

### Protocol (`protocol/`)

New bincode/serde types:

- `ToolboxRequest`: `Hello`, `SynthesisSnapshot`, `SynthesisSeed`,
  `OvermasterySnapshot`, `OvermasterySlot(u32)`
- `ToolboxResponse`: `Hello { protocol_version: u32 }` plus one variant per
  request carrying `Result<T, String>`. Error strings keep today's messages
  ("still on title screen?", "rng slot override active", …).
- The snapshot data types move here: `SynthesisSnapshot`, `SynthesisSigil`,
  `SynthesisSeed`, `OvermasterySnapshot` (already `Serialize`; gain
  `Deserialize`).

**Version guard:** a `PROTOCOL_VERSION: u32` const, bumped on any RPC wire
change. The app makes a `Hello` call (its own connection, like any request)
each time the event stream (re)connects — the moment a new hook can appear —
and on mismatch reports "hook is outdated — restart the game" instead of
decoding garbage.
This matters on Linux, where the deployed `dinput8.dll` proxy stays stale
until the game restarts. On Windows, injection always uses the fresh DLL.

The parser's on-disk log format is unaffected — RPC messages never enter
the event log.

### Shared reader crate (`game-reader/`, new workspace crate)

The walkers and RE'd constants move out of `src-tauri` into a
platform-independent crate, generic over a minimal trait:

```rust
pub trait MemRead {
    fn read(&self, addr: u64, buf: &mut [u8]) -> Result<()>;
    // u32/u64/i32 helpers as provided methods
}
```

Contents:

- `synthesis.rs` / `overmastery.rs`: today's walkers, taking
  `(&impl MemRead, base, rvas)` and returning the protocol snapshot types.
  Every bounds check carries over verbatim: `MAX_MAP_ENTRIES`, walk-overrun,
  roster sanity, the slot-override bail.
- The signatures and offsets (`COMMIT_SIG`, `ROSTER_SIG`, `RNG_SIG`, manager
  offsets), `xorshift32`, `EMPTY_KEY`, `RNG_SLOT_COUNT` — one place to fix
  per game patch, completing what `game_mem.rs`'s doc comment intends.
- Sig-resolution helpers generic over pelite's `Pe` trait so both `PeFile`
  (on-disk, probes) and `PeView` (in-memory, hook) work: `scan_unique_rva`,
  `resolve_rng_rva`, `rva_from_cursor`.
- Unit tests with a fake `MemRead` over a byte-map. The walkers become
  testable for the first time: torn maps, overrun, null sentinel.

pelite is platform-independent, so Linux CI builds and tests this crate.

### Hook (`src-hook/`)

- New `toolbox.rs`: the RPC listener (pipe or TCP per transport), spawned
  from `Server::run` on the hook's tokio runtime — never on a game thread.
- `MemRead` impl = guarded in-process reads: `readable()` (promoted out of
  the diag module) then `copy_nonoverlapping`. In-process, chasing a torn
  map pointer unguarded crashes the game, so every read goes through the
  guard. Walks run at menu cadence, so guard overhead is irrelevant.
- Globals resolve lazily on the first Toolbox request via `PeView::module`,
  then cache for the process lifetime (a game patch requires a restart
  anyway). This deletes the app's on-disk exe read+scan.
- Request handling wraps in `catch_unwind`: a walker panic becomes an error
  response, never an unwind across the listener.

### App (`src-tauri/`)

- The six Tauri commands lose their `#[cfg(windows)]`/stub split — one
  implementation on both platforms that issues the RPC, then runs the
  unchanged pure engines (`synthesis::search`/`predict`,
  `overmastery::simulate`) on the result.
- Connection-refused/timeout maps to the existing "game not running" shape
  (`game_running: false`): from the Toolbox's perspective, "no hook" and
  "no game" both mean "can't read". The frontend distinguishes them with
  the event-stream connection state it already has.
- `game_mem.rs`'s production role ends. The RPM plumbing (`open_game`,
  `Mem`) survives only as the probes' `MemRead` impl, in a dev-only module
  or beside the examples. The `GAME_CACHE` staleness watchers and their
  locking disappear — the hook always has the live process.

### Frontend (`src/`)

- Remove the `windowsOnly` flags from the two Toolbox entries;
  `visibleTools` stops hiding them on Linux. The platform plumbing stays
  for the Linux setup panel.
- Add one empty state beside "game not running": when the meter reports the
  game connected but Toolbox calls fail, show "waiting for game connection
  — restart the game if you just updated", with a pointer to the setup
  panel on Linux. New strings in `src-tauri/lang/en/ui.json` only (other
  languages fall back).

### Diag probes

`om_probe`, `synth_probe`, and `synth_diag` keep their behavior: they call
the shared crate's walkers with the RPM-backed `MemRead` and on-disk
`PeFile` resolution, remaining an independent ground-truth path that can
cross-check the hook. A new `toolbox_probe` example queries the RPC channel
directly, giving a live A/B harness: RPM snapshot vs hook snapshot must
agree.

## Error handling and risks

- **Torn/racy reads:** the same race RPM had; all bails carry over, and
  guarded reads make the worst in-process case an error response, not a
  crash.
- **Wedged hook or frozen game:** the app-side timeout keeps commands
  responsive.
- **Port 39372 taken under Wine:** retry-bind, as the event listener does.
- **Combat impact:** none — the damage path is unchanged and the RPC
  listener idles unless a Toolbox page is open.
- **Version skew (Linux):** handled by the `Hello` version guard above.

## Testing

- **Unit:** shared-crate walkers against fake memory (new coverage);
  protocol round-trips of the new types; transport selection (existing).
- **Live, all on Windows** (Linux differs only in transport): tools
  end-to-end via the pipe; `GBFR_LOGS_FORCE_TCP=1` soaks the exact TCP path
  Linux uses; probe A/B (RPM vs RPC snapshots agree); version-mismatch by
  faking the const.
- **Linux CI:** `game-reader` builds and tests in the existing
  `cargo_check_linux` job.

## Decisions log

- Dedicated RPC channel over a duplex event stream — isolation of the
  combat path, no multiplexing (Claude's pick, delegated 2026-07-23).
- Hook-only on Windows too, no RPM fallback — single code path; the user
  can only test easily on Windows, and the Windows pipe path exercises the
  same code Linux uses (user, 2026-07-23).
- Shared `game-reader` crate over duplicating walkers or porting probes to
  RPC — one source of truth for offsets, probes stay independent ground
  truth (user, 2026-07-23).
