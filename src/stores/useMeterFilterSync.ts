import { invoke } from "@tauri-apps/api";
import { useEffect } from "react";

import { useMeterSettingsStore } from "./useMeterSettingsStore";

/** The backend's `MeterFilters`, camelCase to match its serde rename. */
export type MeterFilters = { includePrimalBurst: boolean };

/**
 * Keeps the parser's damage-source filters in step with the settings store.
 *
 * The backend's copy is in-memory only, so this pushes on mount as well as on
 * change: without the mount push, a restart would leave the parser on the
 * excluding default while the persisted store said otherwise.
 *
 * Mount this ONCE, in the logs window shell. Both windows share the store, so
 * mounting it somewhere both render would push twice per toggle and make the
 * live parser replay its event log twice.
 */
export const useMeterFilterSync = () => {
  // Atomic selector: a selector returning a fresh object literal fails
  // zustand's Object.is check on every store write, so any unrelated settings
  // change (a transparency drag) would push and trigger a live reparse.
  const includePrimalBurst = useMeterSettingsStore((state) => state.include_primal_burst);

  useEffect(() => {
    // Fire-and-forget: there is nothing to do about a failure, and outside a
    // real Tauri window (vitest, a plain-browser `npm run dev`) there is no IPC
    // to reach at all.
    void invoke("set_meter_filters", { filters: { includePrimalBurst } }).catch(() => {});
  }, [includePrimalBurst]);
};
