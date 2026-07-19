import { defaultChecklist, type ChecklistEntry } from "@/utils";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { withStorageDOMEvents } from "./useMeterSettingsStore";

/** A checklist entry plus whether the user has it switched on. */
export type ChecklistSetting = ChecklistEntry & { enabled: boolean };

/** The two editable checklist groups: `build` (Sigils) and `ai` (AI companions). */
export type ChecklistGroup = "build" | "ai";

interface ChecklistState {
  build: ChecklistSetting[];
  ai: ChecklistSetting[];
  /** Entries are keyed by their first trait id (unique within a group). */
  setLevel: (group: ChecklistGroup, firstId: number, level: number) => void;
  toggle: (group: ChecklistGroup, firstId: number) => void;
  remove: (group: ChecklistGroup, firstId: number) => void;
  /** Appends a single-id enabled entry; a trait already present in any entry's id group is a no-op. */
  add: (group: ChecklistGroup, traitId: number, level: number) => void;
  reset: () => void;
}

const seed = (): Pick<ChecklistState, "build" | "ai"> => {
  const defaults = defaultChecklist();
  const enable = (entries: ChecklistEntry[]): ChecklistSetting[] =>
    entries.map((entry) => ({ ...entry, enabled: true }));
  return { build: enable(defaults.build), ai: enable(defaults.ai) };
};

// A partial state update replacing one group's list; keeps the union-keyed
// update type-safe (a computed `[group]:` key would widen to a string index).
const withGroup = (
  state: ChecklistState,
  group: ChecklistGroup,
  update: (entries: ChecklistSetting[]) => ChecklistSetting[]
): Partial<ChecklistState> => (group === "build" ? { build: update(state.build) } : { ai: update(state.ai) });

export const useChecklistStore = create<ChecklistState>()(
  persist(
    (set) => ({
      ...seed(),
      setLevel: (group, firstId, level) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, level } : entry))
          )
        ),
      toggle: (group, firstId) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, enabled: !entry.enabled } : entry))
          )
        ),
      remove: (group, firstId) =>
        set((state) => withGroup(state, group, (entries) => entries.filter((entry) => entry.ids[0] !== firstId))),
      add: (group, traitId, level) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.some((entry) => entry.ids.includes(traitId))
              ? entries
              : [...entries, { ids: [traitId], level, enabled: true }]
          )
        ),
      reset: () => set(seed()),
    }),
    { name: "checklist-settings", version: 1 }
  )
);

withStorageDOMEvents(useChecklistStore);
