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
  /** The characters last worked on (8-hex hashes, or the `ANY` wildcard); the
   * form restores to them on startup. */
  lastCharacters: string[];
  /** How many future rolls to simulate. Account-wide, not per character —
   * it is how far ahead the user likes to look, not a fact about anyone's
   * build. Sanitized on read (`sanitizeRolls`), not here. */
  rolls: number;
  save: (character: string, selection: SavedSelection) => void;
  setLastCharacters: (characters: string[]) => void;
  setRolls: (rolls: number) => void;
}

/** The v1 row: one remembered character rather than a selection. */
type OvermasterySelectionsV1 = {
  selections: Record<string, SavedSelection>;
  lastCharacter: string | null;
  rolls?: number;
};

/** Persists each character's Overmastery Predictor selections (tier + the
 * four wanted slots); entries are sanitized against the tier's pool on read
 * (`sanitizeSelection`), not here. */
export const useOvermasterySelectionsStore = create<OvermasterySelectionsState>()(
  persist(
    (set) => ({
      selections: {},
      lastCharacters: [],
      rolls: DEFAULT_ROLLS,
      // Deliberately not also the selection: the form saves one shared goal
      // under every selected character, so a save is one entry of a loop.
      save: (character, selection) => set((state) => ({ selections: { ...state.selections, [character]: selection } })),
      setLastCharacters: (lastCharacters) => set({ lastCharacters }),
      setRolls: (rolls) => set({ rolls }),
    }),
    {
      name: "overmastery-selections",
      version: 2,
      ...durablePersistOptions<OvermasterySelectionsState>(),
      migrate: (persisted, version) => {
        if (version >= 2) return persisted as OvermasterySelectionsState;
        const { lastCharacter, ...rest } = persisted as OvermasterySelectionsV1;
        return { ...rest, lastCharacters: lastCharacter ? [lastCharacter] : [] } as OvermasterySelectionsState;
      },
    }
  )
);

registerDurableStore(useOvermasterySelectionsStore);
