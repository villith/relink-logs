import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SynthesisForm } from "@/pages/toolbox/useSynthesisHelper";

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
    { name: "synthesis-form", version: 1 }
  )
);

withStorageDOMEvents(useSynthesisFormStore);
