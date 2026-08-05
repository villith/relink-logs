import { invoke } from "@tauri-apps/api";
import { useMemo } from "react";

import useStalenessWatch from "./useStalenessWatch";

/** The part of a prediction this watch needs: which RNG slot the rolls were
 * drawn from, and that slot's state at the moment they were computed. */
export type RngSlotPrediction = {
  slot: number;
  slotState: number;
  unpredictable: boolean;
};

/**
 * Staleness for any tool whose results are a simulation of one RNG slot:
 * while results are shown, poll that slot and latch stale once the live state
 * moves off the one the rolls were computed from (the player rolled, or a
 * quest reshuffled the stream).
 *
 * The backend read is generic (`ToolboxRequest::RngSlot`), so both tools poll
 * through this one hook rather than each issuing the call themselves.
 *
 * A list of predictions is one result set drawn from one snapshot (the
 * Overmastery Predictor's per-character tabs), so any one of their slots
 * moving makes the whole set stale. Pass a stable list — a fresh array every
 * render would restart the watch every render.
 */
export default function useRngSlotStaleness<T extends RngSlotPrediction>(prediction: T | T[] | null) {
  const watched = useMemo(() => {
    const predictable = (Array.isArray(prediction) ? prediction : prediction ? [prediction] : []).filter(
      (p) => !p.unpredictable
    );
    // Deduped by slot: characters can share one, and each is a memory read.
    const slots = [...new Map(predictable.map((p) => [p.slot, p])).values()];
    return slots.length > 0 ? slots : null;
  }, [prediction]);

  return useStalenessWatch(watched, async (slots) => {
    for (const p of slots) {
      const current = await invoke<number | null>("fetch_rng_slot", { slot: p.slot });
      if (current !== null && current !== p.slotState) return true;
    }
    return false;
  });
}
