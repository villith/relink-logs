import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SavedSelection } from "@/pages/toolbox/useOvermasteryPredictor";

import { durableStorage, registerDurableKey } from "./durableStorage";

interface OvermasterySelectionsState {
  /** Wanted-overmastery form selections per character id hash (8-hex). */
  selections: Record<string, SavedSelection>;
  /** The character last worked on; the form restores to them on startup. */
  lastCharacter: string | null;
  save: (character: string, selection: SavedSelection) => void;
}

/** Persists each character's Overmastery Predictor selections (tier + the
 * four wanted slots); entries are sanitized against the tier's pool on read
 * (`sanitizeSelection`), not here. */
export const useOvermasterySelectionsStore = create<OvermasterySelectionsState>()(
  persist(
    (set) => ({
      selections: {},
      lastCharacter: null,
      save: (character, selection) =>
        set((state) => ({ selections: { ...state.selections, [character]: selection }, lastCharacter: character })),
    }),
    {
      name: "overmastery-selections",
      version: 1,
      storage: createJSONStorage(() => durableStorage),
      // Hydration is driven by bootstrapDurableSettings(), which runs after
      // settings.db has had its say. Hydrating at import time would load the
      // cache copy and then get overwritten.
      skipHydration: true,
    }
  )
);

registerDurableKey("overmastery-selections", () => void useOvermasterySelectionsStore.persist.rehydrate());
