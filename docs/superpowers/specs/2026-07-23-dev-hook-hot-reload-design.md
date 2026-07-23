# Dev-only hook hot-reload (eject + re-inject)

**Date:** 2026-07-23
**Status:** Approved

## Problem

Every hook rebuild today requires closing the game and restarting the app: the
injected DLL cannot be replaced while loaded, and `hook-dbg.dll` is file-locked
by the game (the recurring EBUSY failure in `refresh-dbg-hook.mjs`). The dev
loop for hook work is edit → rebuild → close game → relaunch game → relaunch
app → redo the quest.

## Goal

A dev-only "Reload hook" action that swaps in a freshly built hook DLL without
restarting the game or the app: edit → `cargo build -p hook` → tray click →
live in ~2 seconds.

Non-goals: production/end-user hot-reload (release builds contain none of
this), Linux/Proton support (there is no injector there), and preserving the
in-flight encounter across a reload.

## Approach (chosen: graceful teardown + FreeLibrary)

The app asks the hook to tear itself down over the existing toolbox RPC
channel, ejects the dead module with `dll_syringe`, refreshes `hook-dbg.dll`
(now unlocked), and lets the existing reconnect machinery re-inject.

Alternatives considered: never unloading (inject rotating file names; leaks a
module per reload, fiddly pipe/name management) and a permanent loader stub
with a reloadable logic DLL (most engineering, no benefit over eject here).
If FreeLibrary proves crashy in practice, the fallback is the rotating-name
scheme — an app-side-only change.

## Design

### Protocol + gating

- `ToolboxRequest::Eject` and `ToolboxResponse::Eject(Result<(), String>)`,
  appended to the existing enums in `protocol/src/toolbox.rs` (append-only per
  the crate rules; `TOOLBOX_PROTOCOL_VERSION` already guards hook/app skew).
- New cargo feature `eject` on the hook crate. Only with the feature does the
  hook implement the request; `scripts/build-hook-dev.mjs` adds it to the dev
  feature list. A release `hook.dll` answers
  `Err("eject not supported in this build")` and contains no teardown code.
- The app-side trigger exists only under `cfg(all(windows, debug_assertions))`.

### Hook-side teardown

- Each hook module gains `pub(super) fn disable()` that calls `.disable()` on
  its own `static_detour!` statics, ignoring `NotEnabled`/`NotInitialized`
  (a signature that never resolved simply skips).
- `hooks::teardown_hooks()` calls every module's `disable()` with
  `try_step`-style logging, mirroring `setup_hooks`.
- Eject flow, on the hook's tokio runtime (never a game thread):
  1. `serve()` sends the `Ok` response immediately, before teardown, so the
     app is not reading from a dying listener.
  2. A spawned task runs `teardown_hooks()`, sleeps ~300 ms so game threads
     drain out of the trampolines, then signals a global shutdown
     `tokio::sync::Notify`.
  3. `setup()`'s async main `select!`s on that signal and returns; the runtime
     drops (listeners close → the app observes the event pipe closing) and the
     `#[ctor]`-spawned thread exits.
- The fern logger and panic hook are per-DLL statics that die with the module.
  The console (feature `console`) deliberately survives reloads so hookdiag
  output stays continuous; the fresh DLL's `AllocConsole` fails harmlessly.
- Implementation must audit the hook for `std::thread::spawn` outside
  `entry()`: every hook-owned thread must be dead before FreeLibrary.

### App-side orchestration

A **Reload hook (dev)** tray item (Windows debug builds only). Its handler
owns the sequence, coordinated through a new `reloading: AtomicBool` on
`HookStatus`:

1. Set `reloading = true`. `check_and_perform_hook` gains a wait at the top of
   its loop while the flag is set — this closes the race where the automatic
   reconnect loop re-injects before the old module is ejected and the file
   refreshed.
2. Send the `Eject` RPC via the existing `toolbox_rpc` client. On any error
   (release hook, pre-eject hook, game gone): toast via `error-alert`, clear
   the flag, stop.
3. Wait (timeout ~5 s) for `HookStatus.connected` to go false — the pipe
   close already finalizes the in-flight encounter via `on_game_disconnect`
   and respawns `check_and_perform_hook`, which idles on the flag. On
   timeout: toast an error naming the state unknown (restart the game to
   recover), clear the flag, stop — do not eject a module whose threads may
   still be running.
4. Sleep ~300 ms grace, then find the injected module by name
   (`hook-dbg.dll`, falling back to `hook.dll`) and `syringe.eject()` it.
5. Copy `../target/release/hook.dll` → `hook-dbg.dll` (unlocked after eject —
   this also removes the EBUSY papercut). Missing artifact: warn and continue;
   re-injecting the previous DLL merely restores the status quo.
6. Clear `reloading`. The waiting `check_and_perform_hook` injects the fresh
   DLL; its ctor sigscans and hooks; the parser reconnects. Toast success.

### Semantics and accepted trade-offs

- Reloading mid-quest splits the encounter (same as today's mid-quest
  injection). The tray item has no mid-combat guard.
- Each reload leaks a few KB of trampoline allocations (`static_detour!`
  statics never drop). Irrelevant at dev-loop scale.
- Residual risk: a game thread caught inside detour code across both drain
  sleeps crashes the game. Rare; the recovery is today's workflow (restart
  the game).
- If teardown succeeds but eject or copy fails, the hook is dead but the game
  is fine; the toast reports it and a game restart recovers.

## Testing

- Protocol: bincode round-trip of the new variants.
- Hook: `handle_request(Eject)` without the `eject` feature returns the error
  response; `teardown_hooks()` in the test binary (no detours initialized)
  returns cleanly.
- App sequencing is not unit-testable; validate live: reload while idle,
  reload mid-quest, reload with the game closed, reload with the build
  artifact missing.
