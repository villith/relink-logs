import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SigilEntry, WrightstoneEntry } from "@/pages/toolbox/useTransmarvelSearcher";

import { withStorageDOMEvents } from "./useMeterSettingsStore";

interface TransmarvelWishlistState {
  /** Sigil wishlist: (sigil trait1, optional 2nd trait) pairs; deduped by
   * the pair on read. */
  sigils: SigilEntry[];
  /** Wrightstone wishlist; entries validated against the pool on read
   * (`sanitizeWishlists`), not here. */
  stones: WrightstoneEntry[];
  setSigils: (sigils: SigilEntry[]) => void;
  setStones: (stones: WrightstoneEntry[]) => void;
}

/** Persists the Transmarvel Searcher wishlists (account-wide, not
 * per-character — transmarvel is a shared shop). */
export const useTransmarvelWishlistStore = create<TransmarvelWishlistState>()(
  persist(
    (set) => ({
      sigils: [],
      stones: [],
      setSigils: (sigils) => set({ sigils }),
      setStones: (stones) => set({ stones }),
    }),
    { name: "transmarvel-wishlists", version: 1 }
  )
);

withStorageDOMEvents(useTransmarvelWishlistStore);
