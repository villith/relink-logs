import { LogicalSize, appWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { OVERLAY_MIN_SIZE, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

/** Differences this small are rounding between the window's logical size and
 * the webview's client size, not a resize worth recording. */
const SIZE_EPSILON = 2;

/**
 * A size the window itself would never accept, so it cannot be one the user
 * chose by dragging.
 *
 * Minimizing is the case that matters: wry's WM_SIZE handler resizes the
 * webview to the window's client rect unconditionally, and Windows reports a
 * minimized window's client rect as 0x0 — so minimizing the overlay fires a
 * `resize` at 0x0. Recording that would put 0 into the width and height on the
 * settings page (and persist it, if the app is closed while minimized).
 */
const isBelowMinimum = (width: number, height: number) =>
  width < OVERLAY_MIN_SIZE.width || height < OVERLAY_MIN_SIZE.height;

/** How long after we resize the window a `resize` event is still assumed to be
 * our own doing rather than the user's. */
const SELF_RESIZE_QUIET_MS = 500;

const insideTauri = () => "__TAURI_IPC__" in window;

/**
 * Keeps the overlay window and the stored overlay size the same thing, both ways.
 *
 * Overlay-only — call it from the meter window and nowhere else, or the logs
 * window would resize itself to the overlay's dimensions.
 *
 * Reads the size from the DOM (`innerWidth`/`innerHeight`) rather than Tauri's
 * window getters: the overlay is undecorated, so its client box is its logical
 * size, and this avoids depending on getters that the v1 window allowlist can
 * silently refuse.
 *
 * The two directions have to be kept from chasing each other. Applying a size
 * fires a `resize`, which would write back a value that differs by a pixel of
 * rounding, which would apply again — a slow shrink. Hence both an epsilon and
 * a short window after our own `setSize` during which resizes are ignored.
 */
export const useOverlaySize = () => {
  const overlay_width = useMeterSettingsStore((state) => state.overlay_width);
  const overlay_height = useMeterSettingsStore((state) => state.overlay_height);
  const set = useMeterSettingsStore((state) => state.set);
  const appliedAt = useRef(0);

  // Setting → window. Clamped to the window's own floor, which also heals a
  // zero size left behind by a build that recorded one on minimize.
  useEffect(() => {
    if (!insideTauri()) return;
    const width = Math.max(OVERLAY_MIN_SIZE.width, overlay_width);
    const height = Math.max(OVERLAY_MIN_SIZE.height, overlay_height);
    const matches =
      Math.abs(window.innerWidth - width) <= SIZE_EPSILON && Math.abs(window.innerHeight - height) <= SIZE_EPSILON;
    if (matches) return;

    appliedAt.current = Date.now();
    void appWindow.setSize(new LogicalSize(width, height));
  }, [overlay_width, overlay_height]);

  // Window → setting, so dragging the overlay's edge updates the numbers on the
  // settings page instead of leaving them describing a size that no longer exists.
  useEffect(() => {
    if (!insideTauri()) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Date.now() - appliedAt.current < SELF_RESIZE_QUIET_MS) return;
        const width = Math.round(window.innerWidth);
        const height = Math.round(window.innerHeight);
        if (isBelowMinimum(width, height)) return;
        if (Math.abs(width - overlay_width) <= SIZE_EPSILON && Math.abs(height - overlay_height) <= SIZE_EPSILON) {
          return;
        }
        set({ overlay_width: width, overlay_height: height });
      }, 250);
    };

    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [overlay_width, overlay_height, set]);
};
