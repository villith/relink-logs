import { invoke } from "@tauri-apps/api";

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
 */
export default function useRngSlotStaleness<T extends RngSlotPrediction>(prediction: T | null) {
  return useStalenessWatch(prediction && !prediction.unpredictable ? prediction : null, async (watched) => {
    const current = await invoke<number | null>("fetch_rng_slot", { slot: watched.slot });
    return current !== null && current !== watched.slotState;
  });
}
