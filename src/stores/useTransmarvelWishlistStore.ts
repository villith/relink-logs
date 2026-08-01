import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SigilEntry, WrightstoneEntry } from "@/pages/toolbox/useTransmarvelSearcher";

import { durableStorage, registerDurableKey } from "./durableStorage";
import { withStorageDOMEvents } from "./useMeterSettingsStore";

interface TransmarvelWishlistState {
  /** Sigil wishlist: (sigil trait1, optional 2nd trait) pairs; deduped by
   * the pair on read. */
  sigils: SigilEntry[];
  /** Wrightstone wishlist; entries validated against the pool on read
   * (`sanitizeWishlists`), not here. */
  stones: WrightstoneEntry[];
  /** How many upcoming rolls a prediction simulates. Persisted here rather
   * than on its own so the whole tool's state hydrates synchronously from one
   * place — the mount-time auto-predict reads it on the first render. */
  rolls: number;
  setSigils: (sigils: SigilEntry[]) => void;
  setStones: (stones: WrightstoneEntry[]) => void;
  setRolls: (rolls: number) => void;
}

/** Persists the Transmarvel Wishlist entries (account-wide, not
 * per-character — transmarvel is a shared shop). */
export const useTransmarvelWishlistStore = create<TransmarvelWishlistState>()(
  persist(
    (set) => ({
      sigils: [],
      stones: [],
      rolls: 50,
      setSigils: (sigils) => set({ sigils }),
      setStones: (stones) => set({ stones }),
      setRolls: (rolls) => set({ rolls }),
    }),
    {
      name: "transmarvel-wishlists",
      version: 1,
      storage: createJSONStorage(() => durableStorage),
      // Hydration is driven by bootstrapDurableSettings(), which runs after
      // settings.db has had its say. Hydrating at import time would load the
      // cache copy and then get overwritten.
      skipHydration: true,
    }
  )
);

withStorageDOMEvents(useTransmarvelWishlistStore);
registerDurableKey("transmarvel-wishlists", () => void useTransmarvelWishlistStore.persist.rehydrate());
