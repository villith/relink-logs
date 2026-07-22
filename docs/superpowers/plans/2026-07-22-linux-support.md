# Linux Support (Proton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native Linux build of Relink Logs that meters the Windows game running under Steam Proton, with overlay, log history, and auto-update.

**Architecture:** The hook stays a Windows DLL. It gains a `DirectInput8Create` export so Wine loads it from the game folder as a `dinput8.dll` proxy (via `WINEDLLOVERRIDES`), and it detects Wine at runtime to serve events over localhost TCP (port 39371) instead of the named pipe a native Linux app can't open. The Tauri app builds natively for Linux: no injector — it deploys the proxy DLL into the Steam game folder, shows a setup panel, and connects over TCP. Toolbox tools that read game memory from outside the process stay Windows-only. CI splits into hook/windows/linux build jobs plus a publish job emitting a two-platform `latest.json`.

**Tech Stack:** Rust (nightly), Tauri v1, tokio TCP, GitHub Actions (windows-latest + ubuntu-22.04), AppImage/deb.

**Spec:** `docs/superpowers/specs/2026-07-22-linux-support-design.md`

**Verified facts this plan relies on:** the game exe statically imports `DINPUT8.dll`; the Steam appid is `881020`; the game process name is `granblue_fantasy_relink.exe`.

**Branch:** work on `spec/linux-support` (already created).

---

## File map

| File | Change |
|---|---|
| `protocol/src/lib.rs` | Add `TCP_PORT`/`TCP_ADDR`, update transport doc comment |
| `src-hook/src/transport.rs` | NEW — Wine detection + transport selection |
| `src-hook/src/proxy.rs` | NEW — `DirectInput8Create` forwarding export |
| `src-hook/src/lib.rs` | Transport-selected listener (pipe vs TCP), generic `handle_client` |
| `src-hook/Cargo.toml` | Add `Win32_System_LibraryLoader` windows feature |
| `src-tauri/Cargo.toml` | Move windows-only deps to `[target.'cfg(windows)'.dependencies]`; `tempfile` dev-dep; `os-all` tauri feature |
| `src-tauri/src/lib.rs` | `#[cfg(windows)]` on `game_mem`/`synthesis`/`overmastery`; new `linux_support` module |
| `src-tauri/src/linux_support/mod.rs` | NEW — module root (compiled on ALL platforms so Windows CI tests it) |
| `src-tauri/src/linux_support/steam.rs` | NEW — Steam/library/prefix discovery (pure, unit-tested) |
| `src-tauri/src/linux_support/deploy.rs` | NEW — proxy DLL deploy/status/remove (unit-tested) |
| `src-tauri/src/main.rs` | cfg-split injector vs Linux deploy+connect; `connect_event_stream`; Linux setup commands + stubs; platform-aware `hook_config_path`; `GDK_BACKEND=x11`; non-panicking window toggles |
| `src-tauri/tauri.conf.json` | `os` allowlist; `deb.depends` |
| `src/platform.ts` | NEW — cached platform lookup + `useIsLinux` |
| `src/pages/Toolbox.tsx`, `src/pages/Logs.tsx` | Hide windows-only tools / Toolbox tab on Linux |
| `src/pages/settings/LinuxSetupSection.tsx` | NEW — setup checks panel |
| `src/pages/Settings.tsx`, `src/types.ts`, `src-tauri/lang/en/ui.json` | Wire panel, types, strings |
| `scripts/build-hook-dev.mjs` | NEW — skip hook build on non-Windows dev hosts |
| `scripts/dump-exports.py` | NEW — PE export lister (verifies the proxy export) |
| `scripts/make-latest-json.mjs` | NEW — two-platform updater manifest |
| `package.json` | `dev` script uses the guard |
| `.github/workflows/ci.yaml` | New `cargo_check_linux` job |
| `.github/workflows/release.yaml` | Split into build-hook / build-windows / build-linux / publish |
| `README.md`, `CLAUDE.md` | Linux install + dev docs |

Notes that keep later tasks honest:

- `src-tauri/examples/*` are Windows diag tools using `game_mem`. They are **not** touched: Linux CI uses `cargo check -p gbfr-logs` and `cargo test -p gbfr-logs --lib --bins`, which never build examples. Windows CI keeps building them.
- The bincode wire format is untouched — only the byte transport changes. Hook and parser still ship from the same commit.
- Nobody edits `CHANGELOG.md` — that's the user's, at release time.

---

### Task 1: Protocol TCP constants

**Files:**
- Modify: `protocol/src/lib.rs`

- [ ] **Step 1: Write the failing test** — append to `protocol/src/lib.rs`:

```rust
#[cfg(test)]
mod transport_constants {
    #[test]
    fn tcp_addr_and_port_agree() {
        assert_eq!(super::TCP_ADDR, format!("127.0.0.1:{}", super::TCP_PORT));
    }
}
```

- [ ] **Step 2: Run it** — `cargo test -p protocol` — Expected: FAIL (`TCP_ADDR` not found).

- [ ] **Step 3: Implement** — below `pub const PIPE_NAME` in `protocol/src/lib.rs`:

```rust
/// Localhost TCP endpoint used instead of the named pipe when the hook runs
/// under Wine/Proton — a native Linux app cannot open Wine named pipes. Same
/// length-delimited framing and bincode payload as the pipe.
pub const TCP_PORT: u16 = 39371;
pub const TCP_ADDR: &str = "127.0.0.1:39371";
```

Also update the crate-level doc comment: replace the sentence "The protocol between the hook and the parser is a simple named pipe, where the messages are encoded as "bincode" serialized bytes." with:

```text
The protocol between the hook and the parser is a byte stream — a named pipe
on native Windows, localhost TCP when the hook detects it is running under
Wine/Proton (see TCP_ADDR) — carrying "bincode"-serialized messages.
```

- [ ] **Step 4: Run** — `cargo test -p protocol` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add protocol/src/lib.rs && git commit -m "feat(protocol): add localhost TCP endpoint constants for the Wine transport"`

---

### Task 2: Hook transport selection

**Files:**
- Create: `src-hook/src/transport.rs`
- Modify: `src-hook/src/lib.rs` (add `mod transport;`)
- Modify: `src-hook/Cargo.toml` (windows feature)

- [ ] **Step 1: Add the `Win32_System_LibraryLoader` feature** to the `windows` dependency in `src-hook/Cargo.toml`:

```toml
windows = { version = "0.52.0", features = ["Win32_Foundation", "Win32_System_Diagnostics_Debug", "Win32_System_Diagnostics_ToolHelp", "Win32_System_Console", "Win32_System_Memory", "Win32_System_LibraryLoader"] }
```

- [ ] **Step 2: Write the failing tests** — create `src-hook/src/transport.rs`:

```rust
//! Which transport the event server should expose.
//!
//! Native Windows: the named pipe (unchanged). Under Wine/Proton a native
//! Linux app cannot open Wine named pipes, so the server listens on
//! localhost TCP instead. `GBFR_LOGS_FORCE_TCP=1` in the game process
//! environment forces TCP so the path can be soak-tested on Windows.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    NamedPipe,
    Tcp,
}

pub fn select_transport() -> Transport {
    select(
        is_wine(),
        std::env::var("GBFR_LOGS_FORCE_TCP").ok().as_deref(),
    )
}

fn select(wine: bool, force_tcp: Option<&str>) -> Transport {
    if wine || force_tcp == Some("1") {
        Transport::Tcp
    } else {
        Transport::NamedPipe
    }
}

/// Wine/Proton exports `wine_get_version` from ntdll; real Windows never does.
fn is_wine() -> bool {
    use windows::core::s;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    unsafe {
        GetModuleHandleA(s!("ntdll.dll"))
            .map(|ntdll| GetProcAddress(ntdll, s!("wine_get_version")).is_some())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_windows_defaults_to_the_pipe() {
        assert_eq!(select(false, None), Transport::NamedPipe);
    }

    #[test]
    fn wine_selects_tcp() {
        assert_eq!(select(true, None), Transport::Tcp);
    }

    #[test]
    fn force_env_selects_tcp_even_on_native_windows() {
        assert_eq!(select(false, Some("1")), Transport::Tcp);
    }

    #[test]
    fn non_one_force_value_is_ignored() {
        assert_eq!(select(false, Some("0")), Transport::NamedPipe);
        assert_eq!(select(false, Some("")), Transport::NamedPipe);
    }

    /// This test suite runs on real Windows in CI and dev — Wine must not be
    /// detected there.
    #[test]
    fn is_wine_is_false_on_real_windows() {
        assert!(!is_wine());
    }
}
```

Add `mod transport;` to `src-hook/src/lib.rs` next to `mod event;`.

- [ ] **Step 3: Run** — `cargo test -p hook` — Expected: PASS (module + tests compile together; if `select` had been wrong the pure tests would catch it).

- [ ] **Step 4: Commit** — `git add src-hook/src/transport.rs src-hook/src/lib.rs src-hook/Cargo.toml Cargo.lock && git commit -m "feat(hook): Wine detection and transport selection"`

---

### Task 3: Hook TCP listener

**Files:**
- Modify: `src-hook/src/lib.rs`

- [ ] **Step 1: Make `handle_client` generic and split `Server::run` by transport.** In `src-hook/src/lib.rs`, replace `handle_client` and `Server::run` with:

```rust
async fn handle_client<S>(
    mut stream: FramedWrite<S, LengthDelimitedCodec>,
    mut rx: event::Rx,
) -> Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    while let Ok(msg) = rx.recv().await {
        let bytes = protocol::bincode::serialize(&msg)?;
        stream.send(bytes.into()).await?;
    }

    Ok(())
}
```

```rust
    async fn run(&self) {
        match transport::select_transport() {
            transport::Transport::NamedPipe => self.run_pipe().await,
            transport::Transport::Tcp => self.run_tcp().await,
        }
    }

    async fn run_pipe(&self) {
        if let Ok(listener) = PipeListenerOptions::new()
            .path(protocol::PIPE_NAME)
            .mode(PipeMode::Bytes)
            .accept_remote(false)
            .create_tokio_send_only()
        {
            loop {
                let read_pipe = listener.accept().await;
                match read_pipe {
                    Ok(stream) => {
                        let rx = self.tx.subscribe();
                        tokio::spawn(async move {
                            let encoder = LengthDelimitedCodec::new();
                            let writer = FramedWrite::new(stream, encoder);

                            let _ = handle_client(writer, rx).await;
                        });
                    }
                    Err(e) => {
                        warn!("Error accepting client: {:?}", e);
                    }
                }
            }
        }
    }

    // Under Wine/Proton: a native Linux app connects to this directly (Wine
    // sockets are real Linux sockets). Bind failures (port taken) retry
    // rather than killing event delivery for the whole session.
    async fn run_tcp(&self) {
        let listener = loop {
            match tokio::net::TcpListener::bind(protocol::TCP_ADDR).await {
                Ok(listener) => break listener,
                Err(e) => {
                    warn!("Could not bind {}: {e:?}; retrying in 5s", protocol::TCP_ADDR);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        };
        info!("Listening on {}", protocol::TCP_ADDR);
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let rx = self.tx.subscribe();
                    tokio::spawn(async move {
                        let writer = FramedWrite::new(stream, LengthDelimitedCodec::new());
                        let _ = handle_client(writer, rx).await;
                    });
                }
                Err(e) => {
                    warn!("Error accepting client: {:?}", e);
                }
            }
        }
    }
```

Also change the log line in `setup()` from `"Setting up named pipe listener"` to `"Setting up event listener"`.

- [ ] **Step 2: Build + test** — `cargo test -p hook && cargo build --release -p hook` — Expected: PASS / clean build.

- [ ] **Step 3: Commit** — `git add src-hook/src/lib.rs && git commit -m "feat(hook): serve events over localhost TCP when running under Wine"`

---

### Task 4: dinput8 proxy export

**Files:**
- Create: `src-hook/src/proxy.rs`
- Create: `scripts/dump-exports.py`
- Modify: `src-hook/src/lib.rs` (add `mod proxy;`)

- [ ] **Step 1: Create `src-hook/src/proxy.rs`:**

```rust
//! dinput8 proxy export.
//!
//! Under Proton the hook is deployed into the game directory as
//! `dinput8.dll` and loaded at game start via
//! `WINEDLLOVERRIDES="dinput8=n,b"` — the game statically imports
//! DirectInput8Create, which we forward to the real system dinput8 (loaded
//! by explicit system32 path, so Wine resolves its builtin). On Windows the
//! DLL is injected as hook.dll and this export is never called. Loading is
//! all `#[ctor]` needs, so no other change is required for the proxy path.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::core::{s, w, HRESULT};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

type DirectInput8CreateFn = unsafe extern "system" fn(
    hinst: HMODULE,
    version: u32,
    riid: *const c_void,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> HRESULT;

static REAL: OnceLock<Option<DirectInput8CreateFn>> = OnceLock::new();

fn real_create() -> Option<DirectInput8CreateFn> {
    *REAL.get_or_init(|| unsafe {
        let module = LoadLibraryW(w!(r"C:\windows\system32\dinput8.dll")).ok()?;
        let addr = GetProcAddress(module, s!("DirectInput8Create"))?;
        Some(std::mem::transmute::<_, DirectInput8CreateFn>(addr))
    })
}

/// # Safety
/// Called by the loader/game with dinput8's documented ABI; pointers are
/// passed through untouched.
#[no_mangle]
pub unsafe extern "system" fn DirectInput8Create(
    hinst: HMODULE,
    version: u32,
    riid: *const c_void,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> HRESULT {
    match real_create() {
        Some(real) => real(hinst, version, riid, out, outer),
        // E_FAIL — no real dinput8, unreachable on any Windows or Wine.
        None => HRESULT(0x80004005u32 as i32),
    }
}
```

Add `mod proxy;` to `src-hook/src/lib.rs`.

- [ ] **Step 2: Build** — `cargo build --release -p hook` — Expected: clean build.

- [ ] **Step 3: Create `scripts/dump-exports.py`** (export-table lister; verifies the export made it into the cdylib):

```python
"""Print the exported symbol names of a PE file.

Usage: py scripts/dump-exports.py target/release/hook.dll
Used to verify hook.dll exports DirectInput8Create (the dinput8-proxy entry
point the game imports under Proton). No third-party deps.
"""
import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()

e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
assert data[e_lfanew:e_lfanew + 4] == b"PE\0\0", "not a PE file"
coff = e_lfanew + 4
num_sections = struct.unpack_from("<H", data, coff + 2)[0]
opt_size = struct.unpack_from("<H", data, coff + 16)[0]
opt = coff + 20
assert struct.unpack_from("<H", data, opt)[0] == 0x20B, "not PE32+"
dirs = opt + 112

sections = []
sec = opt + opt_size
for i in range(num_sections):
    off = sec + i * 40
    vsz, va = struct.unpack_from("<II", data, off + 8)
    rsz, raw = struct.unpack_from("<II", data, off + 16)
    sections.append((va, vsz, raw, rsz))

def rva2off(rva):
    for va, vsz, raw, rsz in sections:
        if va <= rva < va + max(vsz, rsz):
            return raw + (rva - va)
    raise ValueError(f"rva {rva:#x} not in any section")

export_rva = struct.unpack_from("<I", data, dirs)[0]
if not export_rva:
    sys.exit("no export directory")
exp = rva2off(export_rva)
num_names = struct.unpack_from("<I", data, exp + 24)[0]
names = rva2off(struct.unpack_from("<I", data, exp + 32)[0])
for i in range(num_names):
    name_off = rva2off(struct.unpack_from("<I", data, names + i * 4)[0])
    print(data[name_off:data.index(b"\0", name_off)].decode())
```

- [ ] **Step 4: Verify the export and the ownership marker:**

```powershell
py scripts/dump-exports.py target/release/hook.dll
# Expected output includes: DirectInput8Create
(Get-Item target\release\hook.dll).VersionInfo.CompanyName
# Expected: Relink Logs   (Task 7's Foreign-DLL detection depends on this)
```

If `CompanyName` is empty, the winres metadata is not being embedded — fix that before Task 7 (check `src-hook/build.rs` compiles the `[package.metadata.winres]` block via `winres::WindowsResource::new().compile()`).

- [ ] **Step 5: Run hook tests** — `cargo test -p hook` — Expected: PASS.

- [ ] **Step 6: Commit** — `git add src-hook/src/proxy.rs src-hook/src/lib.rs scripts/dump-exports.py && git commit -m "feat(hook): DirectInput8Create proxy export for Proton loading"`

---

### Task 5: src-tauri platform gating (must keep Windows 100% green)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Confirm the windows-only dependency surface** (should already be true; abort and reassess if not):

```powershell
# Each of these should list ONLY main.rs / game_mem.rs / synthesis / overmastery files:
# (dll_syringe also appears in game_mem.rs)
```
Run: `Grep pattern="use (dll_syringe|interprocess|windows::|pelite)" path=src-tauri/src output_mode=files_with_matches`
Expected: `main.rs`, `game_mem.rs`, `synthesis/snapshot.rs`, `overmastery/snapshot.rs` only.

- [ ] **Step 2: Move windows-only deps in `src-tauri/Cargo.toml`.** Delete the `dll-syringe`, `interprocess`, `pelite`, and `windows` entries from `[dependencies]` and add at the bottom:

```toml
[target.'cfg(windows)'.dependencies]
dll-syringe = "0.15.2"
interprocess = { version = "^2.0", features = ["tokio"] }
pelite = "0.10.0"
windows = { version = "0.52.0", features = [
  "Win32_Foundation",
  "Win32_System_Diagnostics_Debug",
  "Win32_System_Diagnostics_ToolHelp",
  "Win32_System_Threading",
] }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Gate the modules in `src-tauri/src/lib.rs`:**

```rust
pub mod backfill;
pub mod db;
#[cfg(windows)]
pub mod game_mem;
pub mod linux_support;
#[cfg(windows)]
pub mod overmastery;
pub mod parser;
#[cfg(windows)]
pub mod synthesis;
```

Create placeholder `src-tauri/src/linux_support/mod.rs` (filled by Tasks 6–7):

```rust
//! Linux (Proton) support: Steam discovery and proxy-DLL deployment.
//!
//! Compiled on ALL platforms — dev and CI run on Windows, so keeping this
//! path-and-file logic platform-independent is what keeps it unit-tested.
//! Only the thin glue in main.rs is #[cfg(target_os = "linux")].
```

- [ ] **Step 4: cfg-gate `main.rs`.** Changes, top to bottom:

Imports — replace:

```rust
use gbfr_logs::{db, overmastery, parser, synthesis};
...
use dll_syringe::{process::OwnedProcess, Syringe};
use interprocess::os::windows::named_pipe::tokio::RecvPipeStream;
```

with:

```rust
use gbfr_logs::{db, parser};
#[cfg(windows)]
use gbfr_logs::{overmastery, synthesis};
...
#[cfg(windows)]
use dll_syringe::{process::OwnedProcess, Syringe};
#[cfg(windows)]
use interprocess::os::windows::named_pipe::tokio::RecvPipeStream;
```

Toolbox commands — add `#[cfg(windows)]` above each of the six existing command fns (`fetch_synthesis_status`, `search_synthesis`, `fetch_synthesis_seed`, `fetch_overmastery_status`, `predict_overmastery`, `fetch_overmastery_seed`), then add stubs (frontend hides the pages on Linux; these are belt-and-braces):

```rust
/// Non-Windows stubs: these tools read game memory from outside the process,
/// which the Linux build does not support (see the Linux spec). The frontend
/// hides them; the stub keeps the invoke surface identical.
#[cfg(not(windows))]
#[tauri::command]
async fn fetch_synthesis_status() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn search_synthesis() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_synthesis_seed() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_overmastery_status() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn predict_overmastery() -> Result<(), String> {
    Err("windows-only".into())
}

#[cfg(not(windows))]
#[tauri::command]
async fn fetch_overmastery_seed() -> Result<(), String> {
    Err("windows-only".into())
}
```

`check_and_perform_hook` — add `#[cfg(windows)]` above the existing fn, plus a temporary Linux placeholder (replaced in Task 8) so the build stays green:

```rust
// Replaced with the deploy-and-connect flow in the Linux-glue task.
#[cfg(not(windows))]
async fn check_and_perform_hook(app: AppHandle) {
    connect_and_run_parser(app);
}
```

`connect_and_run_parser` — extract the transport connect. Add above it:

```rust
/// Connect to the hook's event stream: the named pipe on Windows (localhost
/// TCP when GBFR_LOGS_FORCE_TCP=1, for parity-testing the Linux path), and
/// localhost TCP elsewhere — under Proton the hook detects Wine and listens
/// on TCP because a native Linux app cannot open Wine named pipes.
async fn connect_event_stream() -> anyhow::Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>> {
    #[cfg(windows)]
    if std::env::var("GBFR_LOGS_FORCE_TCP").as_deref() != Ok("1") {
        let stream = RecvPipeStream::connect_by_path(protocol::PIPE_NAME).await?;
        return Ok(Box::new(stream));
    }
    let stream = tokio::net::TcpStream::connect(protocol::TCP_ADDR).await?;
    Ok(Box::new(stream))
}
```

and inside `connect_and_run_parser` change:

```rust
            match RecvPipeStream::connect_by_path(protocol::PIPE_NAME).await {
```

to:

```rust
            match connect_event_stream().await {
```

(The `Ok(stream)` / `Err(_)` arms, the `FramedRead`, and the 100 ms retry sleep are unchanged — the boxed stream satisfies the same `AsyncRead` bound, and on Linux the connect-refused retry doubles as the "is the game up yet" poll. The tail respawn of `check_and_perform_hook` also stays as-is: both platforms define that name.)

- [ ] **Step 5: Verify Windows is untouched** — `cargo test -p gbfr-logs` and `cargo build -p gbfr-logs` — Expected: all existing tests PASS, clean build. (The Linux side first compiles in CI in Task 13.)

- [ ] **Step 6: Commit** — `git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/lib.rs src-tauri/src/linux_support/mod.rs src-tauri/src/main.rs && git commit -m "refactor(app): platform-gate windows-only memory reading and transport"`

---

### Task 6: Steam discovery (`linux_support::steam`)

**Files:**
- Create: `src-tauri/src/linux_support/steam.rs`
- Modify: `src-tauri/src/linux_support/mod.rs`

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/linux_support/steam.rs` with tests first:

```rust
//! Locate the game's Steam install and Proton prefix on Linux.
//!
//! Pure path/string logic over a provided list of Steam roots so it stays
//! compiled and unit-tested on Windows dev machines and CI. Only main.rs
//! decides which real roots to probe.

use std::fs;
use std::path::{Path, PathBuf};

/// Granblue Fantasy: Relink.
pub const APP_ID: &str = "881020";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamGame {
    /// `<library>/steamapps/common/<installdir>` — where the proxy DLL goes.
    pub game_dir: PathBuf,
    /// `<library>/steamapps/compatdata/881020/pfx` — exists after the first
    /// Proton launch.
    pub prefix_dir: PathBuf,
    /// Where the hook's `dirs::data_dir()` resolves inside Wine — the hook's
    /// config and log live here.
    pub hook_data_dir: PathBuf,
}

/// The Steam roots worth probing, given the user's home directory
/// (native package, legacy symlink layout, flatpak).
pub fn default_steam_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/share/Steam"),
        home.join(".steam/steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    ]
}

/// Find the game in any library of any root. `None` = not installed / no Steam.
pub fn discover(roots: &[PathBuf]) -> Option<SteamGame> {
    for root in roots {
        let mut libraries: Vec<PathBuf> = vec![root.clone()];
        if let Ok(vdf) = fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
            for path in vdf_string_values(&vdf, "path") {
                let path = PathBuf::from(path);
                if !libraries.contains(&path) {
                    libraries.push(path);
                }
            }
        }
        for library in libraries {
            let steamapps = library.join("steamapps");
            let Ok(acf) = fs::read_to_string(steamapps.join(format!("appmanifest_{APP_ID}.acf")))
            else {
                continue;
            };
            let Some(installdir) = vdf_string_values(&acf, "installdir").into_iter().next()
            else {
                continue;
            };
            let game_dir = steamapps.join("common").join(&installdir);
            if !game_dir.is_dir() {
                continue;
            }
            let prefix_dir = steamapps.join("compatdata").join(APP_ID).join("pfx");
            let hook_data_dir = prefix_dir.join("drive_c/users/steamuser/AppData/Roaming/gbfr-logs");
            return Some(SteamGame {
                game_dir,
                prefix_dir,
                hook_data_dir,
            });
        }
    }
    None
}

/// Values of every `"key" "value"` line in a VDF blob. Handles the two
/// escapes Steam writes in paths (`\\` and `\"`); nesting doesn't matter for
/// the keys we read (`path`, `installdir`).
fn vdf_string_values(vdf: &str, key: &str) -> Vec<String> {
    let prefix = format!("\"{key}\"");
    let mut out = Vec::new();
    for line in vdf.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let rest = rest.trim();
        if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
            out.push(rest[1..rest.len() - 1].replace("\\\\", "\\").replace("\\\"", "\""));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARYFOLDERS: &str = r#"
"libraryfolders"
{
    "0"
    {
        "path"		"/home/scott/.local/share/Steam"
        "label"		""
    }
    "1"
    {
        "path"		"/mnt/games/SteamLibrary"
    }
}
"#;

    const APPMANIFEST: &str = r#"
"AppState"
{
    "appid"		"881020"
    "name"		"Granblue Fantasy: Relink"
    "installdir"		"Granblue Fantasy Relink"
}
"#;

    #[test]
    fn vdf_extracts_all_values_of_a_key() {
        assert_eq!(
            vdf_string_values(LIBRARYFOLDERS, "path"),
            vec!["/home/scott/.local/share/Steam", "/mnt/games/SteamLibrary"]
        );
    }

    #[test]
    fn vdf_key_match_is_exact_not_prefix() {
        // "pathext" must not match "path"
        assert!(vdf_string_values("\"pathext\"  \"zzz\"", "path").is_empty());
    }

    #[test]
    fn vdf_unescapes_backslashes() {
        assert_eq!(
            vdf_string_values(r#""path"  "C:\\Games\\Steam""#, "path"),
            vec![r"C:\Games\Steam"]
        );
    }

    #[test]
    fn installdir_is_read_from_the_manifest() {
        assert_eq!(
            vdf_string_values(APPMANIFEST, "installdir"),
            vec!["Granblue Fantasy Relink"]
        );
    }

    #[test]
    fn default_roots_cover_native_legacy_and_flatpak() {
        let roots = default_steam_roots(Path::new("/home/scott"));
        assert_eq!(roots.len(), 3);
        assert!(roots[0].ends_with(".local/share/Steam"));
        assert!(roots[2].to_string_lossy().contains("com.valvesoftware.Steam"));
    }

    /// Full discovery over a fixture tree: root library has the manifest in a
    /// SECOND library listed by libraryfolders.vdf.
    #[test]
    fn discover_walks_secondary_libraries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Steam");
        let second = tmp.path().join("SteamLibrary");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        let game_dir = second.join("steamapps/common/Granblue Fantasy Relink");
        fs::create_dir_all(&game_dir).unwrap();

        let vdf = format!(
            "\"libraryfolders\"\n{{\n  \"0\"\n  {{\n    \"path\"  \"{}\"\n  }}\n}}\n",
            second.display()
        );
        fs::write(root.join("steamapps/libraryfolders.vdf"), vdf).unwrap();
        fs::write(
            second.join(format!("steamapps/appmanifest_{APP_ID}.acf")),
            "\"AppState\"\n{\n  \"installdir\"  \"Granblue Fantasy Relink\"\n}\n",
        )
        .unwrap();

        let game = discover(&[root]).expect("game should be found");
        assert_eq!(game.game_dir, game_dir);
        assert_eq!(
            game.prefix_dir,
            second.join("steamapps/compatdata/881020/pfx")
        );
        assert!(game
            .hook_data_dir
            .ends_with("drive_c/users/steamuser/AppData/Roaming/gbfr-logs"));
    }

    #[test]
    fn discover_returns_none_when_nothing_matches() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(discover(&[tmp.path().to_path_buf()]), None);
    }
}
```

Add to `src-tauri/src/linux_support/mod.rs`:

```rust
pub mod steam;
```

- [ ] **Step 2: Run** — `cargo test -p gbfr-logs linux_support` — Expected: PASS (7 tests). If any fail, fix the implementation (the code above is the intended final form; TDD here means the tests ship in the same file and gate the commit).

- [ ] **Step 3: Commit** — `git add src-tauri/src/linux_support && git commit -m "feat(app): Steam library and Proton prefix discovery"`

---

### Task 7: Proxy deployment (`linux_support::deploy`)

**Files:**
- Create: `src-tauri/src/linux_support/deploy.rs`
- Modify: `src-tauri/src/linux_support/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/linux_support/deploy.rs`** (tests included, same TDD gate as Task 6):

```rust
//! Deploy the hook into the game folder as a dinput8 proxy DLL.
//!
//! `hook.dll` (bundled as a Tauri resource) is copied to
//! `<game_dir>/dinput8.dll`; Wine loads it at game start via the user's
//! `WINEDLLOVERRIDES` launch option. Ownership is detected via the
//! "Relink Logs" CompanyName the hook's winres metadata embeds, so we never
//! clobber or delete another tool's proxy (e.g. ReShade).

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};

pub const PROXY_DLL_NAME: &str = "dinput8.dll";

/// What the user pastes into Steam → Properties → Launch Options.
pub const LAUNCH_OPTIONS: &str = r#"WINEDLLOVERRIDES="dinput8=n,b" %command%"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyStatus {
    /// No dinput8.dll in the game folder.
    Missing,
    /// Byte-identical to the bundled hook.
    Current,
    /// Ours (marker present) but different bytes — an older app version.
    Outdated,
    /// Someone else's dinput8.dll (ReShade, SpecialK, ...). Never touched.
    Foreign,
}

pub fn proxy_status(game_dir: &Path, bundled_hook: &Path) -> Result<ProxyStatus> {
    let target = game_dir.join(PROXY_DLL_NAME);
    if !target.exists() {
        return Ok(ProxyStatus::Missing);
    }
    let existing = fs::read(&target).context("read existing dinput8.dll")?;
    let bundled = fs::read(bundled_hook).context("read bundled hook.dll")?;
    if existing == bundled {
        Ok(ProxyStatus::Current)
    } else if is_ours(&existing) {
        Ok(ProxyStatus::Outdated)
    } else {
        Ok(ProxyStatus::Foreign)
    }
}

/// Copy the bundled hook into place (no-op when already current).
pub fn deploy(game_dir: &Path, bundled_hook: &Path) -> Result<ProxyStatus> {
    match proxy_status(game_dir, bundled_hook)? {
        ProxyStatus::Current => Ok(ProxyStatus::Current),
        ProxyStatus::Foreign => {
            bail!("a dinput8.dll from another tool is already in the game folder")
        }
        ProxyStatus::Missing | ProxyStatus::Outdated => {
            fs::copy(bundled_hook, game_dir.join(PROXY_DLL_NAME))
                .context("copy hook.dll into the game folder")?;
            Ok(ProxyStatus::Current)
        }
    }
}

/// Delete our proxy from the game folder. Refuses foreign DLLs.
pub fn remove(game_dir: &Path) -> Result<()> {
    let target = game_dir.join(PROXY_DLL_NAME);
    if !target.exists() {
        return Ok(());
    }
    if !is_ours(&fs::read(&target).context("read existing dinput8.dll")?) {
        bail!("the dinput8.dll in the game folder is not ours; not deleting it");
    }
    fs::remove_file(&target).context("remove proxy dll")
}

/// The hook's version resource embeds CompanyName "Relink Logs" (UTF-16, see
/// [package.metadata.winres] in src-hook/Cargo.toml) — presence of that
/// string marks a DLL as ours across versions.
fn is_ours(bytes: &[u8]) -> bool {
    let needle: Vec<u8> = "Relink Logs"
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();
    bytes.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ours(extra: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = "Relink Logs"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        bytes.extend_from_slice(extra);
        bytes
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        game_dir: std::path::PathBuf,
        bundled: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let game_dir = tmp.path().join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let bundled = tmp.path().join("hook.dll");
        fs::write(&bundled, ours(b"v2")).unwrap();
        Fixture {
            _tmp: tmp,
            game_dir,
            bundled,
        }
    }

    #[test]
    fn missing_then_deploy_then_current() {
        let f = fixture();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Missing
        );
        assert_eq!(
            deploy(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Current
        );
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Current
        );
    }

    #[test]
    fn our_older_dll_reads_outdated_and_is_replaced() {
        let f = fixture();
        fs::write(f.game_dir.join(PROXY_DLL_NAME), ours(b"v1")).unwrap();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Outdated
        );
        deploy(&f.game_dir, &f.bundled).unwrap();
        assert_eq!(
            fs::read(f.game_dir.join(PROXY_DLL_NAME)).unwrap(),
            fs::read(&f.bundled).unwrap()
        );
    }

    #[test]
    fn foreign_dll_is_never_overwritten_or_deleted() {
        let f = fixture();
        fs::write(f.game_dir.join(PROXY_DLL_NAME), b"reshade or whatever").unwrap();
        assert_eq!(
            proxy_status(&f.game_dir, &f.bundled).unwrap(),
            ProxyStatus::Foreign
        );
        assert!(deploy(&f.game_dir, &f.bundled).is_err());
        assert!(remove(&f.game_dir).is_err());
        assert_eq!(
            fs::read(f.game_dir.join(PROXY_DLL_NAME)).unwrap(),
            b"reshade or whatever"
        );
    }

    #[test]
    fn remove_deletes_ours_and_tolerates_missing() {
        let f = fixture();
        remove(&f.game_dir).unwrap(); // nothing there: ok
        deploy(&f.game_dir, &f.bundled).unwrap();
        remove(&f.game_dir).unwrap();
        assert!(!f.game_dir.join(PROXY_DLL_NAME).exists());
    }
}
```

Add to `src-tauri/src/linux_support/mod.rs`:

```rust
pub mod deploy;
```

- [ ] **Step 2: Run** — `cargo test -p gbfr-logs linux_support` — Expected: PASS (Task 6's 7 + these 4).

- [ ] **Step 3: Commit** — `git add src-tauri/src/linux_support && git commit -m "feat(app): proxy DLL deploy/status/remove with foreign-DLL protection"`

---

### Task 8: Linux glue in main.rs

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Force X11.** First lines of `fn main()` (before `db::setup_db()`):

```rust
    // The overlay depends on WM hints native Wayland refuses to clients
    // (always-on-top, clickthrough); route through XWayland — the game under
    // Proton is an XWayland window anyway. Respect an explicit user choice.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
```

- [ ] **Step 2: Platform-aware `hook_config_path`.** Replace the existing fn body:

```rust
/// Config file the injected hook reads ONCE at startup. It lives in the data
/// dir the HOOK resolves at runtime — `dirs::data_dir()/gbfr-logs` on
/// Windows; on Linux the hook runs inside the Proton prefix, so the same
/// logical path lands inside `pfx/drive_c/...` and we write it there.
fn hook_config_path() -> Result<std::path::PathBuf, String> {
    #[cfg(not(target_os = "linux"))]
    let mut path = {
        let mut path = tauri::api::path::data_dir().ok_or("Could not find the data folder")?;
        path.push("gbfr-logs");
        path
    };
    #[cfg(target_os = "linux")]
    let mut path = {
        use gbfr_logs::linux_support::steam;
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or("HOME is not set")?;
        steam::discover(&steam::default_steam_roots(&home))
            .ok_or("Could not find the game's Steam install")?
            .hook_data_dir
    };
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("hook-config.json");

    Ok(path)
}
```

- [ ] **Step 3: Replace the Task-5 placeholder `check_and_perform_hook` (non-windows)** with the deploy-and-connect flow:

```rust
// Linux: no injector. Refresh the dinput8 proxy in the game folder
// (best-effort — the setup panel surfaces failures), then let the TCP
// connect-retry loop double as the "game running?" poll.
#[cfg(not(windows))]
async fn check_and_perform_hook(app: AppHandle) {
    use gbfr_logs::linux_support::{deploy, steam};

    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let bundled = app.path_resolver().resolve_resource("hook.dll");
    match (home, bundled) {
        (Some(home), Some(bundled)) => {
            match steam::discover(&steam::default_steam_roots(&home)) {
                Some(game) => match deploy::deploy(&game.game_dir, &bundled) {
                    Ok(_) => info!("proxy dinput8.dll is current in {:?}", game.game_dir),
                    Err(e) => log::warn!("could not deploy the proxy DLL: {e:?}"),
                },
                None => log::warn!(
                    "Steam install of the game not found; see Settings → Linux setup"
                ),
            }
        }
        _ => log::warn!("no HOME or no bundled hook.dll; cannot deploy the proxy DLL"),
    }

    connect_and_run_parser(app);
}
```

- [ ] **Step 4: Linux setup commands + stubs.** Add near the other commands:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinuxSetupStatus {
    steam_found: bool,
    game_dir: Option<String>,
    prefix_found: bool,
    /// "missing" | "current" | "outdated" | "foreign"
    proxy_status: String,
    launch_options: String,
}

#[cfg(target_os = "linux")]
mod linux_setup {
    use super::LinuxSetupStatus;
    use gbfr_logs::linux_support::{deploy, steam};
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    fn game_and_hook(app: &AppHandle) -> Result<(steam::SteamGame, PathBuf), String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME is not set")?;
        let game = steam::discover(&steam::default_steam_roots(&home))
            .ok_or("Could not find the game's Steam install")?;
        let bundled = app
            .path_resolver()
            .resolve_resource("hook.dll")
            .ok_or("hook.dll resource missing from this build")?;
        Ok((game, bundled))
    }

    fn status_word(status: deploy::ProxyStatus) -> String {
        match status {
            deploy::ProxyStatus::Missing => "missing",
            deploy::ProxyStatus::Current => "current",
            deploy::ProxyStatus::Outdated => "outdated",
            deploy::ProxyStatus::Foreign => "foreign",
        }
        .into()
    }

    #[tauri::command]
    pub fn fetch_linux_setup_status(app: AppHandle) -> Result<LinuxSetupStatus, String> {
        let Ok((game, bundled)) = game_and_hook(&app) else {
            return Ok(LinuxSetupStatus {
                steam_found: false,
                game_dir: None,
                prefix_found: false,
                proxy_status: "missing".into(),
                launch_options: deploy::LAUNCH_OPTIONS.into(),
            });
        };
        let proxy = deploy::proxy_status(&game.game_dir, &bundled).map_err(|e| e.to_string())?;
        Ok(LinuxSetupStatus {
            steam_found: true,
            game_dir: Some(game.game_dir.display().to_string()),
            prefix_found: game.prefix_dir.is_dir(),
            proxy_status: status_word(proxy),
            launch_options: deploy::LAUNCH_OPTIONS.into(),
        })
    }

    #[tauri::command]
    pub fn deploy_linux_hook(app: AppHandle) -> Result<(), String> {
        let (game, bundled) = game_and_hook(&app)?;
        deploy::deploy(&game.game_dir, &bundled)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn remove_linux_hook(app: AppHandle) -> Result<(), String> {
        let (game, _) = game_and_hook(&app)?;
        deploy::remove(&game.game_dir).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "linux")]
use linux_setup::{deploy_linux_hook, fetch_linux_setup_status, remove_linux_hook};

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn fetch_linux_setup_status() -> Result<(), String> {
    Err("linux-only".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn deploy_linux_hook() -> Result<(), String> {
    Err("linux-only".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn remove_linux_hook() -> Result<(), String> {
    Err("linux-only".into())
}
```

Register all three in `generate_handler!` (append after `set_full_assist_unlock`):

```rust
            fetch_linux_setup_status,
            deploy_linux_hook,
            remove_linux_hook,
```

- [ ] **Step 5: Stop panicking on window-hint failures** (Linux WMs may refuse them; a tray click must never crash the app). In `toggle_clickthrough` replace:

```rust
    window.set_ignore_cursor_events(new_state).unwrap();
```

with:

```rust
    if let Err(e) = window.set_ignore_cursor_events(new_state) {
        log::warn!("set_ignore_cursor_events({new_state}) failed: {e:?}");
    }
```

and in `toggle_always_on_top` replace `window.set_always_on_top(new_state).unwrap();` with:

```rust
    if let Err(e) = window.set_always_on_top(new_state) {
        log::warn!("set_always_on_top({new_state}) failed: {e:?}");
    }
```

- [ ] **Step 6: Verify** — `cargo test -p gbfr-logs && cargo build -p gbfr-logs` — Expected: PASS / clean (Windows). Linux compile is CI's job (Task 13).

- [ ] **Step 7: Commit** — `git add src-tauri/src/main.rs && git commit -m "feat(app): Linux deploy-and-connect flow, setup commands, X11 backend"`

---

### Task 9: tauri.conf.json + os feature

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1:** In `src-tauri/Cargo.toml`, add `"os-all"` to the tauri feature list (alphabetically after `"fs-read-file"` is fine; order is cosmetic).

- [ ] **Step 2:** In `src-tauri/tauri.conf.json` allowlist, after the `"path"` entry add:

```json
      "os": {
        "all": true
      }
```

(The frontend uses `@tauri-apps/api/os` `platform()` — per the Tauri-allowlist memory, a non-allowlisted call rejects silently, so this MUST land with the frontend task.)

- [ ] **Step 3:** In the `bundle` object, after `"resources"` add:

```json
      "deb": {
        "depends": ["libayatana-appindicator3-1"]
      }
```

(System tray on Linux needs an appindicator library at runtime; AppImage embeds it at build via `TAURI_TRAY=ayatana` in Task 14.)

- [ ] **Step 4: Verify** — `cargo build -p gbfr-logs` — Expected: clean (feature exists; conf schema valid).

- [ ] **Step 5: Commit** — `git add src-tauri/tauri.conf.json src-tauri/Cargo.toml Cargo.lock && git commit -m "feat(app): os allowlist and Linux bundle deps"`

---

### Task 10: Frontend platform gating

**Files:**
- Create: `src/platform.ts`
- Create: `src/platform.test.ts`
- Create: `src/pages/Toolbox.test.ts`
- Modify: `src/pages/Toolbox.tsx`
- Modify: `src/pages/Logs.tsx`

- [ ] **Step 1: Write the failing tests.** `src/platform.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/os", () => ({ platform: vi.fn().mockResolvedValue("linux") }));

import { useIsLinux } from "./platform";

test("useIsLinux flips to true once the platform resolves to linux", async () => {
  const { result } = renderHook(() => useIsLinux());
  await waitFor(() => expect(result.current).toBe(true));
});
```

`src/pages/Toolbox.test.ts`:

```ts
import { visibleTools } from "./Toolbox";

const tools = [
  { to: "/a", windowsOnly: true },
  { to: "/b", windowsOnly: true },
  { to: "/c" },
];

test("windows keeps every tool", () => {
  expect(visibleTools(tools, false)).toHaveLength(3);
});

test("linux drops windows-only tools", () => {
  expect(visibleTools(tools, true).map((t) => t.to)).toEqual(["/c"]);
});
```

- [ ] **Step 2: Run** — `npx vitest run src/platform.test.ts src/pages/Toolbox.test.ts` — Expected: FAIL (modules/exports missing). Never use `npm run test` (watch mode, never exits).

- [ ] **Step 3: Implement `src/platform.ts`:**

```ts
import { platform } from "@tauri-apps/api/os";
import { useEffect, useState } from "react";

let cached: Promise<string> | null = null;

/** The OS the backend runs on ("win32" | "linux" | ...), cached for the app's lifetime. */
export function getPlatform(): Promise<string> {
  if (!cached) cached = platform();
  return cached;
}

/** False until the async platform lookup resolves — callers render the Windows/default UI first. */
export function useIsLinux(): boolean {
  const [isLinux, setIsLinux] = useState(false);
  useEffect(() => {
    let mounted = true;
    getPlatform().then((p) => {
      if (mounted) setIsLinux(p === "linux");
    });
    return () => {
      mounted = false;
    };
  }, []);
  return isLinux;
}
```

- [ ] **Step 4: Gate the Toolbox.** In `src/pages/Toolbox.tsx`: add `windowsOnly: true` to both entries in `TOOLS` (extend the element type with `windowsOnly?: boolean`), export the filter, and use it:

```ts
/** Tools visible on this platform: windows-only tools read game memory from
 * outside the process, which the Linux build does not support. */
export const visibleTools = <T extends { windowsOnly?: boolean }>(tools: T[], isLinux: boolean): T[] =>
  tools.filter((tool) => !(isLinux && tool.windowsOnly));
```

In the component body:

```ts
  const isLinux = useIsLinux();
  const tools = visibleTools(TOOLS, isLinux);
```

and map over `tools` instead of `TOOLS` (import `useIsLinux` from `@/platform`).

- [ ] **Step 5: Hide the Toolbox tab on Linux.** In `src/pages/Logs.tsx`, add `const isLinux = useIsLinux();` in `Layout` (import from `@/platform`) and wrap the Toolbox `NavTab`:

```tsx
              {!isLinux && (
                <NavTab to="/logs/toolbox" icon={<Wrench size="1rem" />} active={toolboxActive}>
                  <Group gap={6} wrap="nowrap">
                    {t("ui.toolbox.title")}
                    <NewChip id="toolbox" />
                  </Group>
                </NavTab>
              )}
```

- [ ] **Step 6: Run** — `npx vitest run` and `npm run build` — Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit** — `git add src/platform.ts src/platform.test.ts src/pages/Toolbox.tsx src/pages/Toolbox.test.ts src/pages/Logs.tsx && git commit -m "feat(ui): platform detection; hide windows-only toolbox on linux"`

---

### Task 11: Linux setup panel

**Files:**
- Create: `src/pages/settings/LinuxSetupSection.tsx`
- Modify: `src/types.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src-tauri/lang/en/ui.json`

- [ ] **Step 1: Add the type** to `src/types.ts`:

```ts
/** Mirror of LinuxSetupStatus in src-tauri/src/main.rs. */
export type LinuxSetupStatus = {
  steamFound: boolean;
  gameDir: string | null;
  prefixFound: boolean;
  proxyStatus: "missing" | "current" | "outdated" | "foreign";
  launchOptions: string;
};
```

- [ ] **Step 2: Create `src/pages/settings/LinuxSetupSection.tsx`:**

```tsx
import { LinuxSetupStatus } from "@/types";
import { Alert, Button, Code, CopyButton, Fieldset, Group, Loader, Stack, Text } from "@mantine/core";
import { ArrowsCounterClockwise, CheckCircle, Warning, XCircle } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const CheckRow = ({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) => (
  <Group gap="xs" wrap="nowrap">
    {ok ? (
      <CheckCircle size="1.2rem" color="var(--mantine-color-green-6)" />
    ) : warn ? (
      <Warning size="1.2rem" color="var(--mantine-color-yellow-6)" />
    ) : (
      <XCircle size="1.2rem" color="var(--mantine-color-red-6)" />
    )}
    <Text size="sm">{label}</Text>
  </Group>
);

/** Settings → Linux setup: live checks for the Proton hook-loading chain
 * (game found → proxy DLL deployed → launch options), rendered only on
 * Linux. The launch-options check cannot be probed, so it is presented as a
 * copyable instruction instead. */
export const LinuxSetupSection = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LinuxSetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    invoke<LinuxSetupStatus>("fetch_linux_setup_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const run = (command: "deploy_linux_hook" | "remove_linux_hook") =>
    invoke(command).then(refresh).catch((e) => setError(String(e)));

  if (!status) {
    return (
      <Fieldset legend={t("ui.linux-setup.title", "Linux setup")} mt="md">
        {error ? <Alert color="red">{error}</Alert> : <Loader size="sm" />}
      </Fieldset>
    );
  }

  const proxyLabel = {
    current: t("ui.linux-setup.proxy-current", "Hook is installed in the game folder"),
    missing: t("ui.linux-setup.proxy-missing", "Hook is not installed in the game folder"),
    outdated: t("ui.linux-setup.proxy-outdated", "Installed hook is from an older version"),
    foreign: t(
      "ui.linux-setup.proxy-foreign",
      "Another tool's dinput8.dll is in the game folder — remove it first",
    ),
  }[status.proxyStatus];

  return (
    <Fieldset legend={t("ui.linux-setup.title", "Linux setup")} mt="md">
      <Stack gap="xs">
        {error && <Alert color="red">{error}</Alert>}
        <CheckRow
          ok={status.steamFound}
          label={
            status.steamFound
              ? t("ui.linux-setup.game-found", "Game found: {{dir}}", { dir: status.gameDir })
              : t("ui.linux-setup.game-not-found", "Steam install of the game not found")
          }
        />
        <CheckRow ok={status.proxyStatus === "current"} warn={status.proxyStatus === "outdated"} label={proxyLabel} />
        <CheckRow
          ok={status.prefixFound}
          warn={!status.prefixFound}
          label={
            status.prefixFound
              ? t("ui.linux-setup.prefix-found", "Proton prefix found")
              : t("ui.linux-setup.prefix-missing", "Proton prefix not found — launch the game once via Steam")
          }
        />
        <Text size="sm" mt="xs">
          {t(
            "ui.linux-setup.launch-options-hint",
            "One-time step: paste this into Steam → Granblue Fantasy: Relink → Properties → Launch Options:",
          )}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Code block style={{ flex: 1 }}>
            {status.launchOptions}
          </Code>
          <CopyButton value={status.launchOptions}>
            {({ copied, copy }) => (
              <Button size="compact-sm" variant="light" onClick={copy}>
                {copied ? t("ui.linux-setup.copied", "Copied") : t("ui.linux-setup.copy", "Copy")}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Group gap="xs" mt="xs">
          <Button
            size="compact-sm"
            disabled={!status.steamFound || status.proxyStatus === "current" || status.proxyStatus === "foreign"}
            onClick={() => run("deploy_linux_hook")}
          >
            {t("ui.linux-setup.deploy-btn", "Install hook")}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            disabled={!status.steamFound || status.proxyStatus === "missing" || status.proxyStatus === "foreign"}
            onClick={() => run("remove_linux_hook")}
          >
            {t("ui.linux-setup.remove-btn", "Remove hook")}
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            leftSection={<ArrowsCounterClockwise size="1rem" />}
            onClick={refresh}
          >
            {t("ui.linux-setup.refresh-btn", "Refresh")}
          </Button>
        </Group>
      </Stack>
    </Fieldset>
  );
};
```

- [ ] **Step 3: Wire into Settings.** In `src/pages/Settings.tsx`: import `useIsLinux` from `@/platform` and `LinuxSetupSection` from `./settings/LinuxSetupSection`; add `const isLinux = useIsLinux();` in `SettingsPage`; render after the `Fieldset legend="Logs"` block (before the dev-settings fieldset):

```tsx
      {isLinux && <LinuxSetupSection />}
```

- [ ] **Step 4: English strings.** Merge into the `"ui"` object of `src-tauri/lang/en/ui.json` (keys match the `t()` calls above; other languages fall back to en until translators catch up):

```json
    "linux-setup": {
      "title": "Linux setup",
      "game-found": "Game found: {{dir}}",
      "game-not-found": "Steam install of the game not found",
      "proxy-current": "Hook is installed in the game folder",
      "proxy-missing": "Hook is not installed in the game folder",
      "proxy-outdated": "Installed hook is from an older version",
      "proxy-foreign": "Another tool's dinput8.dll is in the game folder — remove it first",
      "prefix-found": "Proton prefix found",
      "prefix-missing": "Proton prefix not found — launch the game once via Steam",
      "launch-options-hint": "One-time step: paste this into Steam → Granblue Fantasy: Relink → Properties → Launch Options:",
      "copy": "Copy",
      "copied": "Copied",
      "deploy-btn": "Install hook",
      "remove-btn": "Remove hook",
      "refresh-btn": "Refresh"
    }
```

- [ ] **Step 5: Verify** — `npm run build && npx vitest run` — Expected: clean typecheck, tests PASS.

- [ ] **Step 6: Commit** — `git add src/pages/settings/LinuxSetupSection.tsx src/types.ts src/pages/Settings.tsx src-tauri/lang/en/ui.json && git commit -m "feat(ui): Linux setup panel in settings"`

---

### Task 12: Dev-script guard for non-Windows hosts

**Files:**
- Create: `scripts/build-hook-dev.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/build-hook-dev.mjs`:**

```js
// `npm run dev` prelude. The hook crate only compiles for Windows targets, so
// on a Linux/macOS dev host we skip it (live-game work there uses a CI-built
// hook.dll dropped into src-tauri/). On Windows this preserves the exact
// feature set + hook-dbg refresh the dev loop has always used.
import { execSync } from "node:child_process";

if (process.platform === "win32") {
  execSync(
    "cargo build --release --package hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist",
    { stdio: "inherit" },
  );
  execSync("node scripts/refresh-dbg-hook.mjs", { stdio: "inherit" });
} else {
  console.log("[build-hook-dev] non-Windows host: skipping hook.dll build (windows-only crate).");
}
```

- [ ] **Step 2:** In `package.json`, set:

```json
    "dev": "node scripts/build-hook-dev.mjs && vite",
```

- [ ] **Step 3: Verify on Windows** — `node scripts/build-hook-dev.mjs` — Expected: hook builds, refresh-dbg-hook runs (EBUSY warning is fine if the game is open).

- [ ] **Step 4: Commit** — `git add scripts/build-hook-dev.mjs package.json && git commit -m "chore(dev): skip hook build on non-windows dev hosts"`

---

### Task 13: Linux compile+test job in ci.yaml

**Files:**
- Modify: `.github/workflows/ci.yaml`

- [ ] **Step 1: Append the job** (this is the first time the Linux cfg branches compile — expect to iterate on compile errors here, fixing them in the source tasks' files):

```yaml
  cargo_check_linux:
    name: Rust - Linux check
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Tauri v1 Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.0-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
      - run: rustup set auto-self-update disable
      - run: rustup update nightly && rustup default nightly
      - uses: Swatinem/rust-cache@v2
      - run: npm ci
      # generate_context! embeds dist/ at compile time, so the frontend must
      # exist before any cargo command that compiles main.rs.
      - run: npm run build
      - run: cargo check -p protocol
      - run: cargo check -p gbfr-logs
      # --lib --bins: examples are windows-only diag tools and must not build here.
      - run: cargo test -p gbfr-logs --lib --bins
```

- [ ] **Step 2: Push the branch and watch the job:**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: compile-and-test the linux build on every push"
git push -u origin spec/linux-support
gh run watch --exit-status $(gh run list --branch spec/linux-support --workflow "Lint and Format" --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `cargo_check_linux` green. If it fails, fix compile errors in the files from Tasks 5–9 (typical culprits: a missed `#[cfg(windows)]` import, a windows-only type leaking into shared code), commit as `fix(app): linux compile fixes`, push, re-watch. Do not proceed until green.

---

### Task 14: Release workflow split

**Files:**
- Create: `scripts/make-latest-json.mjs`
- Modify: `.github/workflows/release.yaml`

- [ ] **Step 1: Create `scripts/make-latest-json.mjs`:**

```js
// Assembles the updater manifest (latest.json) from built updater artifacts.
// Usage: node scripts/make-latest-json.mjs <version> <notesFile> <assetDir> <owner/repo>
// Expects <assetDir> to contain, flat: *.msi.zip(+.sig) and *.AppImage.tar.gz(+.sig).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, notesFile, assetDir, repo] = process.argv.slice(2);
if (!version || !notesFile || !assetDir || !repo) {
  console.error("usage: make-latest-json.mjs <version> <notesFile> <assetDir> <owner/repo>");
  process.exit(1);
}

const files = readdirSync(assetDir);

// GitHub rewrites spaces in uploaded asset names to dots.
const assetUrl = (name) =>
  `https://github.com/${repo}/releases/download/${version}/${name.replaceAll(" ", ".")}`;

const platformEntry = (suffix) => {
  const artifact = files.find((f) => f.endsWith(suffix));
  if (!artifact) throw new Error(`no *${suffix} in ${assetDir}`);
  const sig = `${artifact}.sig`;
  if (!files.includes(sig)) throw new Error(`missing ${sig}`);
  return {
    signature: readFileSync(join(assetDir, sig), "utf8").trim(),
    url: assetUrl(artifact),
  };
};

const manifest = {
  version,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": platformEntry(".msi.zip"),
    "linux-x86_64": platformEntry(".AppImage.tar.gz"),
  },
};

writeFileSync(join(assetDir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log(readFileSync(join(assetDir, "latest.json"), "utf8"));
```

- [ ] **Step 2: Restructure `.github/workflows/release.yaml`.** Keep the `version` job and the top-of-file comment block (append a paragraph describing the new job split). Replace the single `release` job with four jobs. The windows steps are today's steps redistributed — reproduced in full here so the file can be assembled without diffing against history:

```yaml
  # hook.dll is built once, signed, and shared by BOTH platform builds: on
  # Windows it is the injected DLL; on Linux the app deploys the same signed
  # file into the Proton game folder as the dinput8 proxy. The Authenticode
  # signature is what AV checks in both cases (Wine included).
  build-hook:
    needs: version
    runs-on: windows-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.version.outputs.sha }}
      - name: Install nightly Rust
        shell: bash
        run: |
          rustup set auto-self-update disable
          rustup update nightly && rustup default nightly
      - uses: Swatinem/rust-cache@v2
      - name: Build hook DLL
        run: cargo build --release --package hook
      - name: Sign hook.dll
        uses: azure/trusted-signing-action@v2
        with:
          azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
          azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          endpoint: ${{ vars.AZURE_SIGNING_ENDPOINT }}
          trusted-signing-account-name: ${{ vars.AZURE_SIGNING_ACCOUNT }}
          certificate-profile-name: ${{ vars.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\target\release\hook.dll
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256
      - uses: actions/upload-artifact@v4
        with:
          name: hook-dll
          path: target/release/hook.dll
          if-no-files-found: error

  build-windows:
    needs: [version, build-hook]
    runs-on: windows-latest
    permissions:
      contents: read
    env:
      VERSION: ${{ needs.version.outputs.version }}
      PRODUCT: GBFR Logs
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.version.outputs.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Install nightly Rust
        shell: bash
        run: |
          rustup set auto-self-update disable
          rustup update nightly && rustup default nightly
      - uses: Swatinem/rust-cache@v2
      - name: Install npm dependencies
        run: npm ci
      # The signed hook goes to BOTH paths: src-tauri/hook.dll is the bundled
      # resource, and target/release/hook.dll is what build.rs copies from —
      # rust-cache could otherwise restore a stale UNSIGNED hook.dll there and
      # build.rs would clobber the signed one.
      - uses: actions/download-artifact@v4
        with:
          name: hook-dll
          path: src-tauri
      - name: Mirror signed hook.dll to cargo output path
        shell: bash
        run: mkdir -p target/release && cp src-tauri/hook.dll target/release/hook.dll
      - name: Build frontend
        shell: pwsh
        run: |
          npm run build
          Set-Content -Path .tauri-release-config.json -Value '{"build":{"beforeBuildCommand":""}}' -Encoding utf8
      - name: Build app (pass 1 — compile only)
        run: npx tauri build -b none --config .tauri-release-config.json
      - name: Sign app binary
        uses: azure/trusted-signing-action@v2
        with:
          azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
          azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          endpoint: ${{ vars.AZURE_SIGNING_ENDPOINT }}
          trusted-signing-account-name: ${{ vars.AZURE_SIGNING_ACCOUNT }}
          certificate-profile-name: ${{ vars.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\target\release\${{ env.PRODUCT }}.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256
      - name: Restore signed binary to cargo output path
        shell: pwsh
        run: Copy-Item "target/release/$env:PRODUCT.exe" target/release/gbfr-logs.exe
      - name: Build app (pass 2 — bundle MSI from signed binary)
        run: npx tauri build -b msi --config .tauri-release-config.json
      - name: Verify the packaged binary is still signed
        shell: pwsh
        run: |
          $exe = "target/release/$env:PRODUCT.exe"
          $sig = Get-AuthenticodeSignature $exe
          Write-Host "$exe -> $($sig.Status): $($sig.SignerCertificate.Subject)"
          if ($sig.Status -ne 'Valid') {
            throw "Pass 2 rebuilt the binary and dropped its Authenticode signature."
          }
      - name: Sign MSI installer
        uses: azure/trusted-signing-action@v2
        with:
          azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
          azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          endpoint: ${{ vars.AZURE_SIGNING_ENDPOINT }}
          trusted-signing-account-name: ${{ vars.AZURE_SIGNING_ACCOUNT }}
          certificate-profile-name: ${{ vars.AZURE_CERT_PROFILE }}
          files-folder: ${{ github.workspace }}\target\release\bundle\msi
          files-folder-filter: msi
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256
      - name: Build and minisign the updater artifact
        shell: pwsh
        env:
          TAURI_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
        run: |
          $msiDir = "target/release/bundle/msi"
          $msi = Get-ChildItem "$msiDir/*.msi" | Select-Object -First 1
          $zip = Join-Path $msiDir "$($msi.Name).zip"
          Write-Host "Packaging signed $($msi.Name)"
          Compress-Archive -Path $msi.FullName -DestinationPath $zip -Force
          npx tauri signer sign --private-key "$env:TAURI_PRIVATE_KEY" --password "" $zip
          if (-not (Test-Path "$zip.sig")) { throw "minisign did not produce $zip.sig" }
      - uses: actions/upload-artifact@v4
        with:
          name: windows-bundle
          path: |
            target/release/bundle/msi/*.msi
            target/release/bundle/msi/*.msi.zip
            target/release/bundle/msi/*.msi.zip.sig
          if-no-files-found: error

  build-linux:
    needs: [version, build-hook]
    runs-on: ubuntu-22.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.version.outputs.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Install Tauri v1 Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.0-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
      - name: Install nightly Rust
        run: |
          rustup set auto-self-update disable
          rustup update nightly && rustup default nightly
      - uses: Swatinem/rust-cache@v2
      - name: Install npm dependencies
        run: npm ci
      # The bundle's hook.dll resource — the app deploys it into the game
      # folder as the dinput8 proxy.
      - uses: actions/download-artifact@v4
        with:
          name: hook-dll
          path: src-tauri
      # Single pass: no Authenticode on Linux artifacts, so the updater
      # artifact (.AppImage.tar.gz + .sig) can come straight from the bundler
      # (TAURI_PRIVATE_KEY set => the v1 bundler emits and signs it).
      - name: Build app (AppImage + deb)
        env:
          TAURI_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_KEY_PASSWORD: ""
          TAURI_TRAY: ayatana
        run: npx tauri build -b appimage,deb
      - uses: actions/upload-artifact@v4
        with:
          name: linux-bundle
          path: |
            target/release/bundle/appimage/*.AppImage
            target/release/bundle/appimage/*.AppImage.tar.gz
            target/release/bundle/appimage/*.AppImage.tar.gz.sig
            target/release/bundle/deb/*.deb
          if-no-files-found: error

  publish:
    needs: [version, build-windows, build-linux]
    runs-on: ubuntu-latest
    permissions:
      contents: write # creates the GitHub Release (and its tag)
    env:
      VERSION: ${{ needs.version.outputs.version }}
      PRERELEASE: ${{ needs.version.outputs.prerelease }}
      TARGET_SHA: ${{ needs.version.outputs.sha }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.version.outputs.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Extract release notes from CHANGELOG.md
        id: notes
        shell: bash
        run: |
          if notes="$(node scripts/extract-changelog.mjs "$VERSION")"; then
            echo "Using the CHANGELOG.md section for $VERSION."
          elif [[ "$PRERELEASE" == "true" ]]; then
            notes="Release candidate $VERSION — a test build published from the dev branch. Not intended for general use."
          else
            exit 1
          fi
          {
            echo "$notes"
            echo ""
            echo "Make sure to save and exit the game before updating."
          } > notes.md
      - uses: actions/download-artifact@v4
        with:
          path: dist-assets
          pattern: "*-bundle"
          merge-multiple: true
      - name: Generate latest.json
        run: node scripts/make-latest-json.mjs "$VERSION" notes.md dist-assets "$GITHUB_REPOSITORY"
      - name: Publish GitHub Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          extra=()
          if [[ "$PRERELEASE" == "true" ]]; then extra+=(--prerelease); fi
          gh release create "$VERSION" dist-assets/* \
            --target "$TARGET_SHA" \
            --title "Relink Logs $VERSION" \
            --notes-file notes.md \
            "${extra[@]}"
```

and change the `promote` job's dependency line to:

```yaml
    needs: [version, publish]
```

Caveats to preserve while editing: the `.sig` files DO get uploaded now (they sit in `dist-assets/*`) — that is harmless (the updater reads signatures from latest.json) and simpler than filtering. The `notes` step writes `notes.md` directly instead of a step output — the publish steps are the only consumers.

- [ ] **Step 3: Sanity-check the YAML** — `npx --yes yaml-lint .github/workflows/release.yaml` (or `node -e "const yaml=require('js-yaml')"` is not available — yaml-lint is fine). Expected: valid YAML.

- [ ] **Step 4: Commit** — `git add .github/workflows/release.yaml scripts/make-latest-json.mjs && git commit -m "ci(release): split build into hook/windows/linux and publish a two-platform manifest"`

- [ ] **Step 5: Note for the PR description** (do not do it now): the first real exercise of this workflow is the RC auto-publish when this branch merges to dev. Watch that run end-to-end; the `TAURI_TRAY`/appindicator and AppImage-updater-artifact assumptions are verified there, not locally.

---

### Task 15: Docs + validation checklists

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README** — add a "Linux (Proton)" section after the existing installation instructions:

```markdown
## Linux (Proton)

Relink Logs runs natively on Linux and meters the Windows game running under
Steam's Proton. Steam Deck gaming mode is **not** supported (an external
overlay cannot draw over gamescope).

1. Install the AppImage (auto-updates) or the .deb from the releases page.
2. Launch Relink Logs, open **Settings → Linux setup**, and click
   **Install hook** if it isn't already green.
3. One-time: in Steam → Granblue Fantasy: Relink → Properties → Launch
   Options, paste:
   `WINEDLLOVERRIDES="dinput8=n,b" %command%`
4. Launch the game. The meter connects automatically.

Notes:
- The overlay uses X11 (via XWayland on Wayland desktops). Always-on-top and
  clickthrough behavior can vary by compositor; X11 sessions are the most
  reliable.
- The Synthesis Helper and Overmastery Predictor toolbox tools are
  Windows-only for now.
- The hook file installed into the game folder is the same Authenticode-signed
  `hook.dll` Windows uses, renamed to `dinput8.dll`. **Remove hook** in
  Settings deletes it again.
```

- [ ] **Step 2: CLAUDE.md** — in "Conventions and gotchas", add:

```markdown
- **Linux (Proton) build:** the game has no Linux version; Linux support runs
  the same Windows exe under Proton, so all RE'd signatures/offsets are shared.
  The hook doubles as a `dinput8.dll` proxy (`src-hook/src/proxy.rs`) and
  serves events over localhost TCP (`protocol::TCP_ADDR`) when it detects
  Wine; the app deploys it via `src-tauri/src/linux_support/`. The hook crate
  itself only compiles on Windows — Linux CI (`cargo_check_linux` in ci.yaml)
  builds `-p gbfr-logs` with `--lib --bins` (the examples are Windows diag
  tools). `npm run dev` on a non-Windows host skips the hook build; drop a
  CI-built `hook.dll` into `src-tauri/` for live-game work there.
```

- [ ] **Step 3: Commit** — `git add README.md CLAUDE.md && git commit -m "docs: linux install and dev notes"`

- [ ] **Step 4: Windows TCP soak (manual, with the user — needs the game).** Procedure to hand the user:

1. `setx GBFR_LOGS_FORCE_TCP 1`, then fully exit and restart Steam (so the game inherits it) and start the app from a fresh terminal (so it inherits it too).
2. Launch the game, run a quest: meter fills, log saves, `netstat -ano | findstr 39371` shows the listener inside the game process.
3. Afterwards: `reg delete "HKCU\Environment" /v GBFR_LOGS_FORCE_TCP /f` and restart Steam again.

Expected: identical behavior to the pipe. This validates the exact transport code Linux uses.

- [ ] **Step 5: Linux live validation (needs a Linux machine with Steam + the game; tracked as the release gate, not a coding task):**

1. AppImage launches on stock Ubuntu 22.04+ (X11 session first).
2. Settings → Linux setup: all checks green after following them.
3. Hook log appears under `<library>/steamapps/compatdata/881020/pfx/drive_c/users/steamuser/AppData/Roaming/gbfr-logs/` after game launch (proves the proxy loaded).
4. Meter fills during a quest; log saves; game-close → "Game has closed" → relaunch reconnects.
5. Overlay stays above the game; clickthrough toggles (if `set_ignore_cursor_events` errors in the app log, implement the GTK input-shape fallback flagged in the spec).
6. Repeat 4–5 on a Wayland session (KDE or GNOME) — overlay via XWayland.
7. Tray icon appears (validates the ayatana assumption).
8. Updater: install an older RC AppImage, confirm it updates from `latest.json`.
9. `.deb` installs and launches on Ubuntu.

- [ ] **Step 6: Remind the user** — a `CHANGELOG.md` section for the release version must be written by them before the first stable dispatch that ships Linux.

---

## Self-review notes (kept for the executor)

- Windows behavior is bit-for-bit preserved everywhere except: `connect_and_run_parser` goes through `connect_event_stream` (same pipe call inside), and two `.unwrap()`s on window hints become logged warnings.
- The six Toolbox stubs + three Linux-setup stubs keep one `generate_handler!` list valid on both platforms.
- Names used across tasks: `Transport::{NamedPipe,Tcp}`, `select_transport`, `ProxyStatus::{Missing,Current,Outdated,Foreign}`, `proxy_status`/`deploy`/`remove`, `SteamGame{game_dir,prefix_dir,hook_data_dir}`, `discover`, `default_steam_roots`, `LinuxSetupStatus{steamFound,gameDir,prefixFound,proxyStatus,launchOptions}`, commands `fetch_linux_setup_status`/`deploy_linux_hook`/`remove_linux_hook`, `visibleTools`, `useIsLinux`.
- Known deliberately-deferred risks (spec-sanctioned): clickthrough fallback (validation item 5), `TAURI_TRAY=ayatana` (validation item 7), AppImage updater artifact naming (publish job fails loudly via `make-latest-json.mjs` if the `.AppImage.tar.gz` is missing).
```
