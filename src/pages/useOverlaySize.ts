import { LogicalSize, appWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

/** Differences this small are rounding between the window's logical size and
 * the webview's client size, not a resize worth recording. */
const SIZE_EPSILON = 2;

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

  // Setting → window.
  useEffect(() => {
    if (!insideTauri()) return;
    const matches =
      Math.abs(window.innerWidth - overlay_width) <= SIZE_EPSILON &&
      Math.abs(window.innerHeight - overlay_height) <= SIZE_EPSILON;
    if (matches) return;

    appliedAt.current = Date.now();
    void appWindow.setSize(new LogicalSize(overlay_width, overlay_height));
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
