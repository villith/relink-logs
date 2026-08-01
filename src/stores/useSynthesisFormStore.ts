import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SynthesisForm } from "@/pages/toolbox/useSynthesisHelper";

import { durableStorage, registerDurableKey } from "./durableStorage";
import { withStorageDOMEvents } from "./useMeterSettingsStore";

interface SynthesisFormState {
  /** The last Synthesis Helper form, restored on startup; sanitized on read
   * (`sanitizeSynthesisForm`), not here. */
  saved: SynthesisForm | null;
  save: (form: SynthesisForm) => void;
}

export const useSynthesisFormStore = create<SynthesisFormState>()(
  persist(
    (set) => ({
      saved: null,
      save: (form) => set({ saved: form }),
    }),
    {
      name: "synthesis-form",
      version: 1,
      storage: createJSONStorage(() => durableStorage),
      // Hydration is driven by bootstrapDurableSettings(), which runs after
      // settings.db has had its say. Hydrating at import time would load the
      // cache copy and then get overwritten.
      skipHydration: true,
    }
  )
);

withStorageDOMEvents(useSynthesisFormStore);
registerDurableKey("synthesis-form", () => void useSynthesisFormStore.persist.rehydrate());
