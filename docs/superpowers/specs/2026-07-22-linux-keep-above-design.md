# Linux overlay keep-above improvements — design

Date: 2026-07-22
Status: approved (chat), pending spec review

## Problem

On Linux the meter overlay can fall behind the game. `alwaysOnTop` is only a
request on Linux: X11 window managers usually honor it (but drop it after
hide/show, and fullscreen windows outrank it), and Wayland compositors ignore
it by design — no client-side call can fix that. A tester confirmed the
overlay hides behind the game until they added a keep-above rule in their
desktop settings.

The app already forces `GDK_BACKEND=x11` (main.rs), so on Wayland desktops the
overlay is an XWayland window and X11-style hints apply between it and the
game (also XWayland under Proton).

What the app *can* do:

- **A.** Repair the keep-above hint when it gets dropped, and re-raise the
  window (X11/XWayland path).
- **B.** Detect a Wayland session and show the user the desktop-side fix in
  Settings → Linux setup.

gtk-layer-shell (true Wayland always-on-top) was considered and rejected: it
conflicts with the forced X11 backend, does not work on GNOME, and breaks
interactive dragging of the meter.

## A. Keep-above repair loop (Linux-only)

New `#[cfg(target_os = "linux")]` logic in `src-tauri/src/main.rs`:

- An async task spawned from `.setup()`, ticking every 5 s.
- Each tick is a no-op unless **all** hold:
  1. `AlwaysOnTop` managed state is `true` (tray toggle respected);
  2. the `main` window exists, `is_visible()`, and not `is_minimized()`
     (muted while hidden to tray or minimized).
- When active: `set_always_on_top(true)`, then raise **without focus** via
  GTK on the main thread (`window.gtk_window()` → `gdk::Window::raise()`
  inside `run_on_main_thread`). Never `present()`/`set_focus()` — the game
  must keep focus.
- Failures log at `debug` level (a refusing compositor must not spam
  warnings every 5 s).

A shared `reassert_keep_above(window)` helper (no-op on non-Linux) is also
called when the meter is shown: in `toggle_window_visibility` (tray
open/left-click) and `show_window` (single-instance handler). This fixes the
known "always-on-top lost after hide/show" case immediately instead of within
5 s.

Windows behavior is unchanged.

## B. Wayland detection + in-app guidance

Backend (`linux_setup` mod, main.rs):

- `LinuxSetupStatus` gains two fields, set in both return branches:
  - `session_type`: `"wayland" | "x11" | "unknown"` — from
    `XDG_SESSION_TYPE`; if unset, `"wayland"` when `WAYLAND_DISPLAY` is set,
    else `"unknown"`.
  - `desktop`: raw `XDG_CURRENT_DESKTOP` value, nullable.
- Mirrored in `src/types.ts` (`sessionType`, `desktop`).

Frontend (`src/pages/settings/LinuxSetupSection.tsx`):

- When `sessionType === "wayland"`, render a yellow Mantine `Alert` titled
  "Keeping the overlay on top": the desktop controls window stacking; run the
  game in borderless/windowed mode; if the overlay still hides, add a
  keep-above rule for the `Meter` window.
- A pure helper `keepAboveInstructions(desktop: string | null): string`
  (new file `src/pages/settings/keepAboveInstructions.ts`) returns the
  DE-specific step by substring match on `XDG_CURRENT_DESKTOP`
  (case-insensitive):
  - contains `kde` → KDE window-rule steps (System Settings → Window
    Management → Window Rules; match title `Meter`; Keep above → Force/Yes);
  - contains `gnome` → GNOME has no built-in per-window rule on Wayland;
    suggest an X11 session or an "always on top" shell extension;
  - contains `hyprland` → add to hyprland.conf:
    `windowrulev2 = pin, title:^(Meter)$`;
  - otherwise → generic "look for a Keep Above / window rules option in your
    desktop settings".
- Strings added to `src-tauri/lang/en/ui.json` only (`ui.linux-setup.*`);
  other languages fall back to en.

## Testing

- Vitest unit tests for `keepAboveInstructions` (KDE, GNOME, Hyprland,
  unknown, null).
- Rust side is platform glue with no automated harness; validated live by the
  Linux tester (same as the rest of the Linux support work).

## Out of scope

- gtk-layer-shell / native-Wayland pinning (rejected above).
- Tauri v2 / xdg-toplevel-tag protocol (future; would let users' compositor
  rules persist automatically).
- README FAQ (already documents the user-side story).
