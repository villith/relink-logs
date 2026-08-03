import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SavedSelection } from "@/pages/toolbox/useOvermasteryPredictor";

import { durablePersistOptions, registerDurableStore } from "./durableStorage";

/** How many future rolls a prediction simulates before the user says
 * otherwise. Lives here rather than beside `initialForm` because the store is
 * the end this module may import from: the predictor imports the store's
 * value, so the reverse can only ever be a type import. */
export const DEFAULT_ROLLS = 50;

interface OvermasterySelectionsState {
  /** Wanted-overmastery form selections per character id hash (8-hex). */
  selections: Record<string, SavedSelection>;
  /** The character last worked on; the form restores to them on startup. */
  lastCharacter: string | null;
  /** How many future rolls to simulate. Account-wide, not per character —
   * it is how far ahead the user likes to look, not a fact about anyone's
   * build. Sanitized on read (`sanitizeRolls`), not here. */
  rolls: number;
  save: (character: string, selection: SavedSelection) => void;
  setRolls: (rolls: number) => void;
}

/** Persists each character's Overmastery Predictor selections (tier + the
 * four wanted slots); entries are sanitized against the tier's pool on read
 * (`sanitizeSelection`), not here. */
export const useOvermasterySelectionsStore = create<OvermasterySelectionsState>()(
  persist(
    (set) => ({
      selections: {},
      lastCharacter: null,
      rolls: DEFAULT_ROLLS,
      save: (character, selection) =>
        set((state) => ({ selections: { ...state.selections, [character]: selection }, lastCharacter: character })),
      setRolls: (rolls) => set({ rolls }),
    }),
    {
      name: "overmastery-selections",
      version: 1,
      ...durablePersistOptions<OvermasterySelectionsState>(),
    }
  )
);

registerDurableStore(useOvermasterySelectionsStore);
