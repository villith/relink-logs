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
 * The backend command is named `fetch_overmastery_seed` for the tool that
 * needed it first, but it is a generic single-slot read — keeping the call
 * here means the tools don't each hardcode that mismatch.
 */
export default function useRngSlotStaleness<T extends RngSlotPrediction>(prediction: T | null) {
  return useStalenessWatch(prediction && !prediction.unpredictable ? prediction : null, async (watched) => {
    const current = await invoke<number | null>("fetch_overmastery_seed", { slot: watched.slot });
    return current !== null && current !== watched.slotState;
  });
}
