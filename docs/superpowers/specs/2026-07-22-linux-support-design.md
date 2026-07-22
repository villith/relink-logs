# Linux Support (Proton) — Design

**Date:** 2026-07-22
**Branch:** `spec/linux-support`
**Status:** Draft for review

## Goal

Ship a native Linux build of Relink Logs that works against Granblue Fantasy:
Relink running under Steam's Proton, with the meter overlay, log history, and
auto-update working, distributed from the existing release pipeline.

## Non-goals

- **Steam Deck / gamescope gaming mode.** An external window cannot float over
  a game inside gamescope's embedded compositor. Explicitly unsupported.
- **Non-Steam installs of the game** (Lutris, bare Wine). The setup flow
  assumes Steam's directory layout. Out of scope for v1.
- **The Toolbox tools that read game memory on demand** (Synthesis Helper,
  Overmastery predictor). Windows-only in v1 — see "Toolbox gating" for why
  and for the follow-up path.
- **Native Wayland windowing.** The app forces the X11 backend (see Overlay).
- macOS. Nothing here moves toward or away from it.

## The central fact everything follows from

There is no Linux build of the game. Linux players run the **identical Windows
executable** under Proton (Wine). Consequences:

- Every reverse-engineered AOB signature, vtable offset, and struct offset in
  `src-hook/` works unchanged. Zero re-RE cost, and future game patches are
  fixed once for both platforms.
- `hook.dll` stays a Windows DLL. Inside the game process it cannot tell it is
  on Linux except by asking Wine (which we do, for transport selection).
- All porting work is in the *plumbing*: how the DLL gets loaded, how events
  reach the app, how the app finds the game, and how the app is packaged.

Verified against the installed game (2026-07-22):

- `granblue_fantasy_relink.exe` statically imports `DINPUT8.dll` (and
  `WINMM.dll`), so a dinput8 proxy DLL is loaded at process start.
- The Steam appid is **881020** (`appmanifest_881020.acf`), which fixes the
  Proton prefix path at `<library>/steamapps/compatdata/881020/pfx`.

## Architecture overview

Windows (unchanged):

```
game.exe ← inject hook.dll (dll_syringe) → named pipe \\.\pipe\gbfr-logs → app (parser/UI)
```

Linux (new):

```
Steam launches game.exe under Proton
  └─ Wine loads our dinput8.dll proxy from the game dir (WINEDLLOVERRIDES)
       └─ #[ctor] entry runs → detects Wine → listens on TCP 127.0.0.1:39371
            → native Linux app connects over localhost TCP → same bincode stream → parser/UI
```

The hook binary is **one artifact** used both ways: on Windows it is injected
as `hook.dll`; on Linux the app copies the same file into the game directory
as `dinput8.dll`.

## Component design

### 1. Hook (`src-hook/`)

Three additions; the hooks/RE core is untouched.

**a. dinput8 proxy export.** Export `DirectInput8Create` (the only dinput8
entry point the game imports), forwarding to the real
`C:\windows\system32\dinput8.dll` (loaded with an explicit full path so the
Wine builtin is used, exactly how ReShade's proxy works under Proton). The
export is always compiled in; on Windows, where the DLL is injected under the
name `hook.dll`, it is simply never called. `#[ctor]` already runs on
`DllMain` load, so proxy loading triggers the existing entry path with no
changes.

**b. Wine detection.** `is_wine()`: `GetProcAddress(GetModuleHandleA("ntdll"),
"wine_get_version") != null`. Standard, stable across every Wine/Proton
version. An env override (`GBFR_LOGS_FORCE_TCP=1` in the hook's environment)
forces the TCP path so the transport can be integration-tested on Windows
without Proton.

**c. Transport selection in `Server::run`.** Not Wine → named pipe listener,
byte-for-byte today's behavior. Wine → `tokio::net::TcpListener` bound to
`127.0.0.1:39371`, same accept-loop shape (multiple send-only clients, each a
`FramedWrite<_, LengthDelimitedCodec>` fed from the broadcast channel — only
the stream type changes; `handle_client` becomes generic over
`AsyncWrite`). Wine's winsock maps to a real Linux socket, so the native app
connects directly. If the bind fails (port taken), log and retry every few
seconds rather than dying — same spirit as the current silent
`if let Ok(listener)`.

Localhost-only binding, send-only protocol, no data more sensitive than what
the overlay displays — the security posture matches the named pipe's
`accept_remote(false)`.

### 2. Protocol crate

- New constants next to `PIPE_NAME`: `TCP_PORT: u16 = 39371` and
  `TCP_ADDR: &str = "127.0.0.1:39371"` (one source of truth for hook and app).
- Update the crate-level doc comment: transport is a named pipe on Windows and
  localhost TCP under Wine/Linux; bincode framing and the compiled-together
  requirement are unchanged.

### 3. App backend (`src-tauri/`)

**Platform split.** `check_and_perform_hook` and the pipe client are
`#[cfg(windows)]`; Linux gets its own `linux/` module with three pieces:

**a. Steam discovery** (`linux/steam.rs`). Locate the Steam root by probing,
in order: `~/.local/share/Steam`, `~/.steam/steam`,
`~/.var/app/com.valvesoftware.Steam/.local/share/Steam` (flatpak). Parse
`steamapps/libraryfolders.vdf` (trivial VDF — a few lines of parsing, no new
dependency) to enumerate libraries; find `appmanifest_881020.acf` to get the
library holding the game. Derive:

- game dir: `<library>/steamapps/common/Granblue Fantasy Relink/`
- prefix: `<library>/steamapps/compatdata/881020/pfx/`
- hook data dir (where the hook's `dirs::data_dir()` resolves inside Wine):
  `<prefix>/drive_c/users/steamuser/AppData/Roaming/gbfr-logs/`

The hook data dir matters because `hook-config.json` and the hook's log file
live there on Linux; `hook_config_path()` in `main.rs` becomes
platform-aware.

**b. Hook deployment** (`linux/deploy.rs`). On every app start (and from a
"repair" button): if `<game dir>/dinput8.dll` is missing or differs
(byte-compare/hash) from the bundled hook resource, copy it over. This also
keeps the proxy current across app updates — deployment is idempotent and
runs before the connect loop. The app never edits Steam's config files: the
user sets the launch options themselves (writing `localconfig.vdf` requires
Steam to be closed and risks corruption — not worth it for a one-time paste).

**c. Setup status + connect loop.** Replace the injection loop with:
deploy-if-needed, then `TcpStream::connect(TCP_ADDR)` retried every second —
the exact shape of today's pipe reconnect loop in `connect_and_run_parser`,
with `FramedRead` over a `TcpStream` instead of `RecvPipeStream`. Late
connection loses pre-connection events, which matches today's Windows
semantics (the pipe listener also starts with the game).

**Setup UX.** A Linux-only setup panel (settings page and/or first-run) that
shows three live checks — game install found; proxy DLL deployed & current;
launch options set (not detectable directly, so shown as an instruction) —
with the exact string to paste into Steam → Properties → Launch Options,
behind a copy button:

```
WINEDLLOVERRIDES="dinput8=n,b" %command%
```

**Toolbox gating.** `game_mem.rs` is built on `OpenProcess` /
`ReadProcessMemory` / Toolhelp — all meaningless against a Wine process from
outside. The Linux equivalent (`process_vm_readv` on the Wine pid) exists but
is blocked by Ubuntu's default Yama `ptrace_scope=1` for non-child processes,
and asking users to change a kernel security sysctl or grant
`CAP_SYS_PTRACE` is unacceptable for v1. So: `game_mem`, `synthesis`, and
`overmastery` are `#[cfg(windows)]`; their Tauri commands return a
"not available on Linux" error; the frontend hides the corresponding Toolbox
pages on Linux (platform exposed to the frontend via a small `get_platform`
command or `navigator` detection). Follow-up path (not v1): make the wire
bidirectional (request/response messages) and serve these reads from inside
the hook, which needs no privileges at all — that is the *right* long-term
design on both platforms but is a protocol change with its own spec.

### 4. Overlay and windowing

- **Force X11:** set `GDK_BACKEND=x11` in `main()` (only if unset) before
  Tauri/GTK initializes. Rationale: the transparent, always-on-top,
  decoration-less overlay depends on window-manager hints that native Wayland
  deliberately does not expose to clients. Under XWayland, KWin and Mutter
  honor always-on-top hints, and the game itself is an XWayland window (Proton
  has no Wayland driver in mainstream use), so overlay-over-game works on both
  X11 and Wayland *sessions*.
- **Transparency** requires a compositing WM — universally true on GNOME/KDE;
  worth one line in the README for exotic WM users.
- **Clickthrough** (`toggle_clickthrough`, `main.rs:945`): Tauri v1's
  `set_ignore_cursor_events` has historically been Windows/macOS-only on some
  tao versions. Implementation must verify on Linux; if unsupported, implement
  via GTK input-shape (`gtk_widget_input_shape_combine_region` with an empty
  region — the standard X11 clickthrough technique, small and contained). In
  all cases the existing `.unwrap()` becomes a logged failure, not a panic.
- `additionalBrowserArgs` in `tauri.conf.json` is WebView2-only and is ignored
  on Linux — no action needed.
- System tray: needs `libayatana-appindicator` on the user's system; listed as
  a .deb dependency and bundled in the AppImage (Tauri v1 tooling handles
  both).

### 5. Frontend (`src/`)

Minimal: a platform flag in a store, the Linux setup panel, hiding
memory-reader Toolbox pages, and README/setup copy. No parser or meter
changes — the event stream is identical.

### 6. Packaging, CI, updater

**Targets:** AppImage (primary — self-contained, distro-agnostic, and the only
Linux target Tauri v1's updater can auto-update) plus `.deb` (convenience;
updates via the release page, the app still shows the update prompt).

**Release workflow restructure** (`release.yaml`): the current single
`release` job becomes three build jobs plus a publish job:

- `build-hook` (windows runner): `cargo build --release -p hook`, Authenticode
  sign (unchanged — the signature keeps AV happy and is valid inside Wine),
  upload `hook.dll` as an artifact.
- `build-windows` (windows runner): today's two-pass signed MSI dance,
  consuming the hook artifact; uploads MSI + updater zip + minisign sig.
- `build-linux` (ubuntu-22.04 runner): install webkit2gtk-4.0 & friends,
  download the hook artifact into `src-tauri/hook.dll` (same resource glob —
  the bundle config already lists `hook.dll`), `npx tauri build -b
  appimage,deb`, minisign the `.AppImage.tar.gz` updater artifact with the
  existing `TAURI_PRIVATE_KEY`. No Authenticode, no two-pass problem — Linux
  artifacts aren't Authenticode-signed at all.
- `publish`: assembles `latest.json` with **both** `windows-x86_64` and
  `linux-x86_64` platform entries and creates the GitHub release with all
  assets. (Today's latest.json generation moves here from the windows job.)

The version/RC/promote jobs, deploy-key push model, and the human-written
CHANGELOG gate are untouched. Older installed Windows apps ignore the new
platform key in `latest.json`.

**ubuntu-22.04 pin:** Tauri v1 needs webkit2gtk-4.0, which 24.04 dropped —
22.04 is the supported GitHub runner for v1 Linux builds and yields an
AppImage compatible with all mainstream distros.

**Dev workflow:** `npm run tauri dev` on Linux works once the hook build step
is skipped or cross-targeted; simplest is a small script guard — on Linux,
`npm run dev` skips the `cargo build -p hook` (the DLL can't be built without
a Windows toolchain) and developers use a prebuilt `hook.dll` from CI when
they need live-game work. Documented in CLAUDE.md/README as part of
implementation.

## Error handling and edge cases

- **Steam not found / game not installed:** setup panel shows which check
  failed; connect loop stays idle instead of spinning on deploy errors.
- **Game dir not writable:** surfaced in the setup panel with the path to copy
  manually. (Steam libraries are user-writable in every standard setup.)
- **TCP port already bound** (hook side): log + periodic retry. (App side
  connect-refused is already the normal "game not running" state.)
- **A second dinput8 proxy already present** (e.g. ReShade under Proton): v1
  detects a foreign `dinput8.dll` and reports the conflict in the setup panel
  rather than overwriting; chain-loading a foreign proxy is out of scope.
- **Steam "verify integrity"** leaves foreign files alone; a game *update*
  also leaves `dinput8.dll` in place. Harmless either way — the proxy without
  the app just forwards dinput and listens on localhost.
- **Uninstall/cleanup:** a "remove from game folder" button deletes the
  deployed `dinput8.dll` and reminds the user to clear the launch options.
- **Old logs:** the DB schema and encounter format are platform-independent;
  nothing migrates.

## Testing and validation plan

1. **Unit:** VDF/library discovery and deploy logic against fixture trees;
   transport selection behind the env override. Pure logic stays testable
   without a game, per the project's existing pattern.
2. **Windows TCP soak:** run the full stack on Windows with
   `GBFR_LOGS_FORCE_TCP=1` (hook) and a matching app-side override — proves
   the new transport end-to-end against the live game without any Linux
   machine involved, and exercises the exact code Linux will use.
3. **CI artifacts:** AppImage/deb build green; AppImage launches on a stock
   Ubuntu 22.04/24.04 VM (no GPU needed for the app itself).
4. **Live Proton validation** (the only step needing real Linux + the game):
   proxy loads (hook log appears under the prefix), meter fills during a
   quest, logs save, overlay sits above the game on X11 and on a Wayland
   session via XWayland, clickthrough toggles, updater applies an RC.
   Requires a Linux install with Steam + the game — dual-boot or a spare
   machine; a GPU-less VM cannot run the game.

## Risks and open questions

- **Clickthrough on Linux in Tauri v1** — may need the GTK input-shape
  fallback (bounded, well-understood work). Verified during implementation.
- **Overlay behavior varies by compositor** on Wayland sessions (XWayland
  always-on-top is honored by KWin/Mutter but is technically WM-discretionary).
  Accepted risk; X11 sessions are fully deterministic.
- **Proton updates** could in principle change builtin-DLL override behavior;
  `WINEDLLOVERRIDES` + native-proxy loading is a decade-stable, ecosystem-load-bearing
  mechanism (ReShade, SpecialK, countless mods). Low risk.
- **Support surface:** Linux bug reports will span distros/compositors. The
  setup panel's explicit checks are the main mitigation.

## Future work (explicitly not v1)

- Bidirectional hook channel → Toolbox memory tools on Linux (and a cleaner
  design on Windows).
- Non-Steam install support (manual game-dir picker would get most of it).
- Flatpak/AUR packaging if demand appears (AppImage covers the gap).
