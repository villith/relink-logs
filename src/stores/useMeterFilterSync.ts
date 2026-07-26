import { invoke } from "@tauri-apps/api";
import { useEffect, useMemo } from "react";

import { MeterFilters } from "@/types";

import { useMeterSettingsStore } from "./useMeterSettingsStore";

/**
 * The settings store's filter flags in the shape the backend expects.
 *
 * The snake_case↔camelCase mapping lives here and nowhere else, so a new flag
 * reaches every `fetch_encounter_state` caller at once instead of having to be
 * added to each one's inline object literal. Memoised so the result is stable
 * enough to use as a `useEffect` dependency.
 */
export const useMeterFilters = (): MeterFilters => {
  // Atomic selector: see the note in useMeterFilterSync below.
  const includePrimalBurst = useMeterSettingsStore((state) => state.include_primal_burst);

  return useMemo(() => ({ includePrimalBurst }), [includePrimalBurst]);
};

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
  // Atomic selector (inside useMeterFilters): a selector returning a fresh
  // object literal fails zustand's Object.is check on every store write, so any
  // unrelated settings change (a transparency drag) would push and trigger a
  // live reparse.
  const filters = useMeterFilters();

  useEffect(() => {
    // Fire-and-forget: there is nothing to do about a failure, and outside a
    // real Tauri window (vitest, a plain-browser `npm run dev`) there is no IPC
    // to reach at all.
    void invoke("set_meter_filters", { filters }).catch(() => {});
  }, [filters]);
};
