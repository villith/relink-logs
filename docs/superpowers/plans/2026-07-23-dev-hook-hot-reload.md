# Dev-Only Hook Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev-only "Reload hook (dev)" tray action that swaps a freshly built hook DLL into the running game — no game or app restart.

**Architecture:** The app sends a new `Eject` toolbox RPC; the hook (feature `eject` only) disables every static detour, drains, and shuts down its tokio runtime; the app then FreeLibrary-s the dead module via `dll_syringe::Syringe::eject`, refreshes `hook-dbg.dll` (unlocked after eject), and the existing reconnect loop re-injects. Spec: `docs/superpowers/specs/2026-07-23-dev-hook-hot-reload-design.md`.

> **AS-BUILT (2026-07-23):** `Eject` was NOT added to the Toolbox RPC. Per a
> mid-implementation design decision, it rides a dedicated dev-only control
> channel `protocol::control` (`HookControlRequest`/`HookControlResponse` over
> `\\.\pipe\gbfr-logs-control` / `HOOK_CONTROL_TCP_ADDR`) instead — a lifecycle
> command does not belong in the Toolbox tool enum, and this leaves every
> toolbox wire shape and `TOOLBOX_PROTOCOL_VERSION` untouched. Concretely, vs.
> the tasks below: **Task 1** created `protocol/src/control.rs` (not toolbox
> variants); **Task 3** added `src-hook/src/control.rs` (a control listener
> under the `eject` feature) and left `src-hook/src/toolbox.rs` unchanged — no
> `handle_request`/`eject_supported` arm; **Task 4/5** put the client in
> `gbfr_logs::control_rpc` (`#[cfg(all(windows, debug_assertions))]`) and call
> `control_rpc::eject()`. Tasks 2 and 6 were executed as written, except
> `player::disable()` gates `BuildPlayerProfile` behind `hookdiag` (it is a
> hookdiag-only detour). All commits landed on `feat/auto-reload-dll-dev`.

**Tech Stack:** Rust — `retour` 0.3.1 static detours, `dll-syringe` 0.15.2, tokio, Tauri v1 system tray. No frontend changes.

**⚠ Working-tree caution:** The checkout has UNRELATED uncommitted changes (Pl2000 identity fix in `src-hook/src/hooks/damage.rs`, `src-hook/src/hooks/mod.rs`, `src-tauri/src/parser/v1/mod.rs`, plus stray root files). Never `git add -A` / `git add -u`. Stage only the exact files each commit step names. Work on the current branch `feat/toolbox-hook-rpc`. Do NOT use git worktrees (repo rule).

**Verification note:** `cargo test -p hook` and Windows-only paths require a Windows host (this machine). Never run `npm run test` (watch mode); frontend is untouched anyway.

---

### Task 1: Protocol — `Eject` request/response variants

**Files:**
- Modify: `protocol/src/toolbox.rs`

- [ ] **Step 1: Write the failing test**

Append to the existing `mod tests` in `protocol/src/toolbox.rs`:

```rust
    /// Appended variants must round-trip; the error string is what the
    /// reload toast shows verbatim.
    #[test]
    fn eject_round_trips_through_bincode() {
        let req = ToolboxRequest::Eject;
        let bytes = bincode::serialize(&req).unwrap();
        assert_eq!(bincode::deserialize::<ToolboxRequest>(&bytes).unwrap(), req);

        let resp = ToolboxResponse::Eject(Err("nope".into()));
        let bytes = bincode::serialize(&resp).unwrap();
        let ToolboxResponse::Eject(Err(msg)) =
            bincode::deserialize::<ToolboxResponse>(&bytes).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(msg, "nope");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p protocol eject_round_trips`
Expected: COMPILE ERROR — `no variant named 'Eject'`

- [ ] **Step 3: Add the variants (append-only — never reorder existing ones)**

In `protocol/src/toolbox.rs`, add as the LAST variant of `ToolboxRequest`:

```rust
    /// Dev-only (hook feature `eject`): tear down all detours and shut down
    /// the hook runtime so the app can FreeLibrary the module and inject a
    /// rebuilt one. Release hooks answer `Err`.
    Eject,
```

and as the LAST variant of `ToolboxResponse`:

```rust
    /// `Ok` = teardown begins after this response is sent; the pipe closing
    /// signals completion. Deliberately NOT a TOOLBOX_PROTOCOL_VERSION bump:
    /// appended variants leave every existing wire shape untouched, and an
    /// old hook that cannot decode the request just drops the connection
    /// (the RPC client surfaces that as an error).
    Eject(Result<(), String>),
```

Do NOT change `TOOLBOX_PROTOCOL_VERSION` — a bump would falsely mark perfectly good release hooks "outdated" for the synthesis/overmastery tools.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p protocol`
Expected: all PASS (including the pre-existing round-trip test)

- [ ] **Step 5: Commit**

```bash
git add protocol/src/toolbox.rs
git commit -m "feat(protocol): toolbox Eject request/response for dev hook hot-reload"
```

---

### Task 2: Hook — `eject` feature, `disable_quiet` helper, per-module `disable()`, `teardown_hooks()`

**Files:**
- Modify: `src-hook/Cargo.toml`
- Modify: `src-hook/src/hooks/mod.rs`
- Modify: `src-hook/src/hooks/area.rs`, `damage.rs`, `death.rs`, `endless.rs`, `player.rs`, `quest.rs`, `sba.rs`, `stunnet.rs`, `assist.rs`, `loadprobe.rs`

- [ ] **Step 1: Add the feature to `src-hook/Cargo.toml`**

In the `[features]` section, after `fullassist`:

```toml
# DEV ONLY: the hook tears down its detours and shuts down its runtime on a
# toolbox `Eject` request, so the app can FreeLibrary + re-inject a rebuilt
# DLL without a game restart. Never built for release.
eject = []
```

- [ ] **Step 2: Write the failing test**

At the BOTTOM of `src-hook/src/hooks/mod.rs`, add:

```rust
#[cfg(test)]
mod teardown_tests {
    /// In the test binary no detour is ever initialized; teardown must treat
    /// that as "nothing to do" for every hook and return cleanly.
    #[test]
    fn teardown_hooks_with_no_detours_initialized_returns_cleanly() {
        super::teardown_hooks();
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p hook teardown_hooks_with_no_detours`
Expected: COMPILE ERROR — `cannot find function 'teardown_hooks'`

- [ ] **Step 4: Add the helper + `teardown_hooks` in `src-hook/src/hooks/mod.rs`**

Directly below the existing `try_step` function, add:

```rust
/// Disable one static detour during dev eject. `NotInitialized` is the
/// normal case for a signature that never resolved on this game build, so it
/// is silent; anything else is logged but must not stop the other detours.
#[cfg(any(feature = "eject", test))]
fn disable_quiet<T: retour::Function>(name: &str, detour: &retour::StaticDetour<T>) {
    match unsafe { detour.disable() } {
        Ok(()) => log::info!("[hook off] {name}"),
        Err(retour::Error::NotInitialized) => {}
        Err(e) => log::warn!("[hook off FAIL] {name}: {e:?}"),
    }
}
```

Directly below `setup_hooks`, add:

```rust
/// Dev-only (feature `eject`): disable every detour `setup_hooks` may have
/// installed, in mirror order. After this, no game thread can ENTER our
/// code; callers still wait a drain period for threads already inside a
/// trampoline before the module is ejected (see crate::teardown).
#[cfg(any(feature = "eject", test))]
pub fn teardown_hooks() {
    damage::disable();
    death::disable();
    player::disable();
    stunnet::disable();
    area::disable();
    quest::disable();
    endless::disable();
    sba::disable();
    #[cfg(feature = "hookdiag")]
    loadprobe::disable();
    #[cfg(any(feature = "fullassist", test))]
    assist::disable();
    log::info!("all detours disabled");
}
```

- [ ] **Step 5: Add each module's `disable()`**

Every function below is gated `#[cfg(any(feature = "eject", test))]` and placed directly after the module's `static_detour!` block(s). The detour static names come from each module's `static_detour!` declarations — if a name below doesn't compile, re-check that block, don't guess.

`src-hook/src/hooks/area.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnEnterArea", &OnEnterArea);
}
```

`src-hook/src/hooks/damage.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("ProcessDamageEvent", &ProcessDamageEvent);
    super::disable_quiet("ProcessDamageBypass", &ProcessDamageBypass);
    super::disable_quiet("ProcessDotEvent0", &ProcessDotEvent0);
    super::disable_quiet("ProcessDotEvent1", &ProcessDotEvent1);
    super::disable_quiet("ProcessDotEvent2", &ProcessDotEvent2);
    #[cfg(feature = "hookdiag")]
    super::disable_quiet("DisplayDamage", &DisplayDamage);
}
```

`src-hook/src/hooks/death.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnDeathEvent", &OnDeathEvent);
}
```

`src-hook/src/hooks/endless.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnReceptionFlowDispatch", &OnReceptionFlowDispatch);
    super::disable_quiet("OnEndlessBuffInstall", &OnEndlessBuffInstall);
    super::disable_quiet("OnEndlessMgrDtor", &OnEndlessMgrDtor);
}
```

`src-hook/src/hooks/player.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnLoadPlayer", &OnLoadPlayer);
    super::disable_quiet("RefreshPlayerIdentity", &RefreshPlayerIdentity);
    super::disable_quiet("BuildPlayerProfile", &BuildPlayerProfile);
}
```

`src-hook/src/hooks/quest.rs` (note: this file has THREE `static_detour!` blocks; put the fn after the last one):

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnLoadQuestState", &OnLoadQuestState);
    super::disable_quiet("OnShowResultScreen", &OnShowResultScreen);
    super::disable_quiet("OnSetRetireSelect", &OnSetRetireSelect);
    super::disable_quiet("QuestSequenceTick", &QuestSequenceTick);
}
```

`src-hook/src/hooks/sba.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("OnSBAUpdate", &OnSBAUpdate);
    super::disable_quiet("OnSBAAttempt", &OnSBAAttempt);
    super::disable_quiet("OnCheckSBACollision", &OnCheckSBACollision);
    super::disable_quiet("OnContinueSBAChain", &OnContinueSBAChain);
    super::disable_quiet("OnRemoteSBAUpdate", &OnRemoteSBAUpdate);
}
```

`src-hook/src/hooks/stunnet.rs`:

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("NetworkStun", &NetworkStun);
}
```

`src-hook/src/hooks/assist.rs` (module itself is `cfg(any(feature = "fullassist", test))`, so this gate composes):

```rust
#[cfg(any(feature = "eject", test))]
pub(super) fn disable() {
    super::disable_quiet("FullAssistGate", &FullAssistGate);
}
```

`src-hook/src/hooks/loadprobe.rs` — the detour lives in the `#[cfg(feature = "hookdiag")] mod imp`. Inside `mod imp` (after the `static_detour!` block) add:

```rust
    #[cfg(any(feature = "eject", test))]
    pub(in crate::hooks) fn disable() {
        crate::hooks::disable_quiet("Dispatcher", &Dispatcher);
    }
```

and next to the existing `pub use imp::OnComponentLookupProbe;` at the top of the file add:

```rust
#[cfg(all(feature = "hookdiag", any(feature = "eject", test)))]
pub(super) use imp::disable;
```

- [ ] **Step 6: Run tests to verify they pass (both feature sets)**

Run: `cargo test -p hook`
Expected: PASS, including `teardown_hooks_with_no_detours_initialized_returns_cleanly`

Run: `cargo test -p hook --features eject,hookdiag,fullassist,console,dmgdiag`
Expected: PASS (proves the cfg combinations compile together)

- [ ] **Step 7: Commit**

```bash
git add src-hook/Cargo.toml src-hook/src/hooks/mod.rs src-hook/src/hooks/area.rs src-hook/src/hooks/damage.rs src-hook/src/hooks/death.rs src-hook/src/hooks/endless.rs src-hook/src/hooks/player.rs src-hook/src/hooks/quest.rs src-hook/src/hooks/sba.rs src-hook/src/hooks/stunnet.rs src-hook/src/hooks/assist.rs src-hook/src/hooks/loadprobe.rs
git commit -m "feat(hook): eject feature — per-module detour disable + teardown_hooks"
```

(`damage.rs` and `hooks/mod.rs` carry unrelated uncommitted Pl2000 work — staging the whole file is unavoidable and acceptable ONLY if that work is already committed by then; otherwise use `git add -p` on those two files and stage just the hunks this task added.)

---

### Task 3: Hook — teardown module, `Eject` handling, runtime shutdown

**Files:**
- Create: `src-hook/src/teardown.rs`
- Modify: `src-hook/src/lib.rs`
- Modify: `src-hook/src/toolbox.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-hook/src/teardown.rs`:

```rust
//! Dev-only (feature `eject`): graceful self-teardown so the app can
//! FreeLibrary this module and inject a rebuilt one without a game restart.
//!
//! Sequence (see the design spec): the toolbox `serve` task calls [`begin`]
//! AFTER flushing the Eject response; we disable every detour, wait a drain
//! period for game threads still inside a trampoline, then signal [`
//! shutdown_notified`] so `setup()` exits its runtime — which closes the
//! event pipe, the app's cue to eject the module.

use std::time::Duration;

use tokio::sync::Notify;

static SHUTDOWN: Notify = Notify::const_new();

/// Resolves once teardown has finished; `setup()` selects on this to exit
/// the runtime (dropping every listener → the app sees the pipe close).
pub async fn shutdown_notified() {
    SHUTDOWN.notified().await;
}

/// Disable all detours, drain, then signal shutdown. Must be called from
/// within the hook's tokio runtime.
pub fn begin() {
    tokio::spawn(async {
        crate::hooks::teardown_hooks();
        // Drain: a game thread that entered a trampoline just before the
        // disable must fall out before this module can be unmapped. The app
        // waits a further grace on its side after the pipe closes.
        tokio::time::sleep(Duration::from_millis(300)).await;
        // notify_one stores a permit, so the signal is never lost even if
        // nothing is awaiting yet.
        SHUTDOWN.notify_one();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Covers the whole in-process teardown path against a non-game binary:
    /// begin() must disable (no-op here), drain, and signal — never hang.
    #[tokio::test]
    async fn begin_tears_down_and_signals_shutdown() {
        begin();
        tokio::time::timeout(std::time::Duration::from_secs(5), shutdown_notified())
            .await
            .expect("teardown never signaled shutdown");
    }
}
```

Append to `mod tests` in `src-hook/src/toolbox.rs`:

```rust
    /// Release builds must refuse; `eject` builds accept (the actual
    /// teardown is triggered by `serve`, not by the handler).
    #[test]
    fn eject_response_matches_the_build_features() {
        let ToolboxResponse::Eject(result) = handle_request(ToolboxRequest::Eject) else {
            panic!("wrong variant");
        };
        #[cfg(not(feature = "eject"))]
        assert!(result.is_err());
        #[cfg(feature = "eject")]
        assert_eq!(result, Ok(()));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hook eject_response`
Expected: COMPILE ERROR — `ToolboxRequest::Eject` not handled / non-exhaustive match in `handle_request`

- [ ] **Step 3: Wire the module and the handler**

In `src-hook/src/lib.rs`, with the other `mod` declarations:

```rust
#[cfg(any(feature = "eject", test))]
mod teardown;
```

In `src-hook/src/lib.rs`, replace the final line of `setup()` (`server.run().await;`) with:

```rust
    // Dev eject: exit the runtime when teardown signals, which closes every
    // listener — the app's cue that this module is safe to FreeLibrary.
    #[cfg(feature = "eject")]
    tokio::select! {
        _ = server.run() => {}
        _ = teardown::shutdown_notified() => {
            log::info!("eject: hook runtime shutting down");
        }
    }
    #[cfg(not(feature = "eject"))]
    server.run().await;
```

In `src-hook/src/toolbox.rs`, add a match arm to `handle_request` (after the `OvermasterySlot` arm):

```rust
        ToolboxRequest::Eject => ToolboxResponse::Eject(eject_supported()),
```

and below `handle_request` add:

```rust
/// Whether this build can eject itself. The teardown itself is triggered by
/// `serve` after the response frame is flushed.
#[cfg(feature = "eject")]
fn eject_supported() -> Result<(), String> {
    Ok(())
}
#[cfg(not(feature = "eject"))]
fn eject_supported() -> Result<(), String> {
    Err("eject not supported in this build".to_string())
}
```

In `serve()` (same file), after the `match protocol::bincode::serialize(&resp) { ... }` block, add:

```rust
    // Teardown strictly AFTER the response is flushed, so the app never
    // reads from a dying listener. ToolboxRequest is Copy.
    #[cfg(feature = "eject")]
    if req == ToolboxRequest::Eject {
        crate::teardown::begin();
    }
```

- [ ] **Step 4: Confirm the thread audit still holds**

Run: `grep -rn "thread::spawn" src-hook/src`
Expected: exactly ONE hit — `lib.rs` `entry()` spawning `setup`. That thread exits when `setup()` returns, so no hook-owned thread outlives the runtime shutdown. If new hits appear, STOP and extend the teardown to stop them before the shutdown signal.

- [ ] **Step 5: Run tests to verify they pass (both feature sets)**

Run: `cargo test -p hook`
Expected: PASS (`eject_response...` takes the `is_err` branch; `begin_tears_down...` passes)

Run: `cargo test -p hook --features eject,hookdiag,fullassist,console,dmgdiag`
Expected: PASS (`eject_response...` takes the `Ok` branch)

- [ ] **Step 6: Commit**

```bash
git add src-hook/src/teardown.rs src-hook/src/lib.rs src-hook/src/toolbox.rs
git commit -m "feat(hook): Eject RPC — graceful detour teardown + runtime shutdown"
```

---

### Task 4: App — `reloading` flag, injection-loop gate, `eject()` RPC client

**Files:**
- Modify: `src-tauri/src/toolbox_rpc.rs`
- Modify: `src-tauri/src/main.rs` (`check_and_perform_hook`, around line 836)

- [ ] **Step 1: Add the flag and the client call**

In `src-tauri/src/toolbox_rpc.rs`, add a field to `HookStatus`:

```rust
    /// Dev hook hot-reload in flight (debug builds only set it): the
    /// injection loop must not re-inject until the old module is ejected and
    /// hook-dbg.dll refreshed. See `reload_hook` in main.rs.
    pub reloading: AtomicBool,
```

and add after `hello_ok`:

```rust
/// Dev hook hot-reload: ask the hook to tear itself down (feature `eject`
/// builds only). Deliberately NOT routed through `request()` — the reload
/// flow wants raw errors for its toast, not the frontend slug mapping.
#[cfg(all(windows, debug_assertions))]
pub async fn eject() -> Result<()> {
    match call(ToolboxRequest::Eject).await? {
        ToolboxResponse::Eject(Ok(())) => Ok(()),
        ToolboxResponse::Eject(Err(e)) => bail!("hook refused eject: {e}"),
        other => bail!("unexpected toolbox response {other:?}"),
    }
}
```

- [ ] **Step 2: Gate the injection loop**

In `src-tauri/src/main.rs`, inside the `loop {` of the Windows `check_and_perform_hook` (before `match OwnedProcess::find_first_by_name(...)`), add:

```rust
        // Dev hook reload in flight: the old module must be ejected and
        // hook-dbg.dll refreshed before we may inject again (see reload_hook).
        #[cfg(debug_assertions)]
        while app.state::<HookStatus>().reloading.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
```

- [ ] **Step 3: Verify it compiles + existing gating tests pass**

Run: `cargo test -p gbfr-logs toolbox_rpc`
Expected: PASS (the three existing `HookStatus` gating tests; `Default` covers the new field)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/toolbox_rpc.rs src-tauri/src/main.rs
git commit -m "feat(app): reloading gate on the injection loop + toolbox eject client"
```

---

### Task 5: App — the reload orchestration + tray item

**Files:**
- Modify: `src-tauri/src/main.rs` (`system_tray_with_menu` ~line 1062, `menu_tray_handler` ~line 1174, new fns near `check_and_perform_hook`)

- [ ] **Step 1: Add the orchestration functions**

In `src-tauri/src/main.rs`, directly below `check_and_perform_hook`, add:

```rust
/// Dev-only hook hot-reload: ask the running hook to tear itself down, eject
/// the dead module, refresh hook-dbg.dll from the cargo artifact, and let
/// the standard reconnect loop re-inject. See
/// docs/superpowers/specs/2026-07-23-dev-hook-hot-reload-design.md.
#[cfg(all(windows, debug_assertions))]
async fn reload_hook(app: AppHandle) {
    if app
        .state::<HookStatus>()
        .reloading
        .swap(true, Ordering::SeqCst)
    {
        return; // a reload is already in flight
    }
    let result = reload_hook_inner(&app).await;
    app.state::<HookStatus>()
        .reloading
        .store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            info!("hook reload complete");
            let _ = app.emit_all("success-alert", "Hook reloaded");
        }
        Err(e) => {
            log::warn!("hook reload failed: {e:?}");
            let _ = app.emit_all("error-alert", format!("Hook reload failed: {e}"));
        }
    }
}

#[cfg(all(windows, debug_assertions))]
async fn reload_hook_inner(app: &AppHandle) -> anyhow::Result<()> {
    use anyhow::{anyhow, bail, Context};
    use dll_syringe::process::Process as _;

    toolbox_rpc::eject().await?;

    // The event pipe closing (connect loop flips `connected` off) means the
    // hook's runtime exited. Timing out means the hook is half-dead —
    // ejecting would FreeLibrary a module with live threads, so refuse.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while app
        .state::<HookStatus>()
        .connected
        .load(Ordering::Relaxed)
    {
        if std::time::Instant::now() >= deadline {
            bail!("hook did not shut down within 5s; state unknown — restart the game");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // Grace: the setup thread finishes exiting shortly after its runtime
    // drops (the pipe closes slightly before the thread is gone).
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let target = OwnedProcess::find_first_by_name(gbfr_logs::game_mem::GAME_EXE)
        .ok_or_else(|| anyhow!("game process not found"))?;
    let syringe = Syringe::for_process(target);
    let module = match syringe.process().find_module_by_name("hook-dbg.dll")? {
        Some(m) => Some(m),
        None => syringe.process().find_module_by_name("hook.dll")?,
    };
    match module {
        Some(module) => {
            syringe.eject(module).context("FreeLibrary of the old hook")?;
            info!("old hook module ejected");
        }
        // Not fatal: nothing loaded means inject-from-scratch, which the
        // reconnect loop does anyway.
        None => log::warn!("no hook module found in the game process; skipping eject"),
    }

    // The file is unlocked now — refresh it from the dev build artifact.
    // CWD is src-tauri under `npm run tauri dev`, matching the relative
    // hook-dbg.dll path in check_and_perform_hook.
    let artifact = Path::new("../target/release/hook.dll");
    if artifact.exists() {
        std::fs::copy(artifact, "hook-dbg.dll").context("refreshing hook-dbg.dll")?;
        info!("hook-dbg.dll refreshed from {artifact:?}");
    } else {
        log::warn!("{artifact:?} not found; re-injecting the existing hook-dbg.dll");
    }
    Ok(())
}
```

- [ ] **Step 2: Add the tray item**

In `system_tray_with_menu`, replace the single builder chain with:

```rust
    let menu = SystemTrayMenu::new()
        .add_item(meter)
        .add_item(logs)
        .add_item(always_on_top)
        .add_item(toggle_clickthrough)
        .add_item(reset_windows);

    // eslint-style note: tray strings don't go through i18next (backend);
    // dev-only item, English is fine.
    #[cfg(all(windows, debug_assertions))]
    let menu = menu.add_item(CustomMenuItem::new("reload_hook", "Reload hook (dev)"));

    let menu = menu
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
```

- [ ] **Step 3: Handle the click**

In `menu_tray_handler`, add an arm before the `_ => {}` fallback:

```rust
            #[cfg(all(windows, debug_assertions))]
            "reload_hook" => {
                tauri::async_runtime::spawn(reload_hook(handle.clone()));
            }
```

- [ ] **Step 4: Verify it compiles clean**

Run: `cargo clippy -p gbfr-logs --lib --bins`
Expected: no new warnings (dev profile ⇒ `debug_assertions` on, so the new code is checked)

Run: `cargo clippy -p gbfr-logs --release --lib --bins`
Expected: no new warnings (proves the `cfg`-off combination compiles too)

(If either clippy run fails in build.rs with "path matching hook.dll not found", build the hook first — see the `building-gbfr-logs` skill — then re-run.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(app): Reload hook (dev) tray action — eject, refresh, re-inject"
```

---

### Task 6: Dev build script + docs

**Files:**
- Modify: `scripts/build-hook-dev.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the feature to the dev hook build**

In `scripts/build-hook-dev.mjs`, extend the feature list:

```js
  execSync("cargo build --release --package hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject", {
    stdio: "inherit",
  });
```

- [ ] **Step 2: Document the dev loop**

In `CLAUDE.md`, add one bullet under "Conventions and gotchas" (after the hook-dbg.dll–related context wherever it reads naturally):

```markdown
- **Dev hook hot-reload:** with the game and a debug app running, rebuild the
  hook (`cargo build --release -p hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject`)
  and click tray → "Reload hook (dev)". The app ejects the old DLL, refreshes
  `hook-dbg.dll` from `target/release/hook.dll`, and re-injects — no game or
  app restart. Dev-only: release hooks refuse the Eject RPC.
```

- [ ] **Step 3: Sanity-run the script build command**

Run: `cargo build --release --package hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject`
Expected: builds clean

- [ ] **Step 4: Commit**

```bash
git add scripts/build-hook-dev.mjs CLAUDE.md
git commit -m "chore(dev): build hook-dbg with the eject feature + document hot-reload"
```

---

### Task 7: Full verification + live validation (manual)

- [ ] **Step 1: Full automated pass**

Run, expecting all green:

```bash
cargo test -p protocol
cargo test -p hook
cargo test -p hook --features eject,hookdiag,fullassist,console,dmgdiag
cargo test -p gbfr-logs
cargo clippy --workspace --all-targets
```

(No frontend changes — do not run vitest.)

- [ ] **Step 2: Live validation (needs the game; hand-run with the user)**

1. `npm run tauri dev` with the game running; wait for "Connected to game".
2. Tray → "Reload hook (dev)" while idle in town → expect "Hook reloaded" toast, hook log shows `all detours disabled` then fresh `[hook ok]` lines, meter reconnects.
3. Make a trivial hook edit (e.g. bump a log line), rebuild with the Task 6 command, reload → verify the edit is live (log line changed) without game/app restart.
4. Reload mid-quest → encounter splits (finalized + fresh), no crash, damage keeps flowing after.
5. Close the game, click reload → "Hook reload failed" toast naming the RPC error; app returns to waiting for the game.
6. Delete/rename `target/release/hook.dll`, reload → warning path: old DLL re-injected, still works.

Known acceptable outcome: a rare game crash at eject (thread caught in a trampoline) — recovery is the old workflow.

- [ ] **Step 3: Wrap up**

Use superpowers:finishing-a-development-branch. Note for the human: CHANGELOG.md is yours to write if this ships in a release; a dev-only feature may not need an entry.
