import { defaultChecklist, moveItem, type ChecklistEntry, type ChecklistGroupKind } from "@/utils";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { withStorageDOMEvents } from "./useMeterSettingsStore";

/** A checklist entry plus whether the user has it switched on. */
export type ChecklistSetting = ChecklistEntry & { enabled: boolean };

/** A checklist group as the user has configured it. */
export type ChecklistGroup = {
  /** Stable key: "build" | "computed" | "ai" for seeded groups, "g-<n>" for new ones. */
  id: string;
  /** i18n key for a seeded group's name; cleared on rename. */
  nameKey?: string;
  /** User-set literal name; wins over nameKey. */
  name?: string;
  kind: ChecklistGroupKind;
  /** Group-level switch; off hides the whole group from the Builds tab. */
  enabled: boolean;
  /** false = render sorted by translated trait name; true = render in stored
   * order. Ignored for kind "computed", whose rows are fixed. */
  manualOrder: boolean;
  entries: ChecklistSetting[];
};

interface ChecklistState {
  groups: ChecklistGroup[];
  /** Entries are keyed by their first trait id (unique within a group). */
  setLevel: (groupId: string, firstId: number, level: number) => void;
  toggle: (groupId: string, firstId: number) => void;
  remove: (groupId: string, firstId: number) => void;
  /** Appends a single-id enabled entry; a trait already in this group's id sets is a no-op. */
  add: (groupId: string, traitId: number, level: number) => void;
  /** Appends an empty custom group with the given (already translated) name; returns its id. */
  addGroup: (name: string) => string;
  renameGroup: (groupId: string, name: string) => void;
  removeGroup: (groupId: string) => void;
  toggleGroup: (groupId: string) => void;
  reorderGroups: (from: number, to: number) => void;
  /** Writes an explicit display order (entry first-ids) and pins the group to manual order. */
  reorderEntries: (groupId: string, order: number[]) => void;
  /** Moves an entry to another group, landing it in `order` — the destination's ids after the drop. */
  moveEntry: (fromGroupId: string, toGroupId: string, firstId: number, order: number[]) => void;
  /** Returns the group to automatic alphabetical order. */
  sortGroup: (groupId: string) => void;
  reset: () => void;
}

export const seed = (): ChecklistGroup[] =>
  defaultChecklist().map((group) => ({
    ...group,
    enabled: true,
    manualOrder: false,
    entries: group.entries.map((entry) => ({ ...entry, enabled: true })),
  }));

/** Applies `update` to one group, leaving the rest of the list identical. */
const withGroup = (
  groups: ChecklistGroup[],
  groupId: string,
  update: (group: ChecklistGroup) => ChecklistGroup
): ChecklistGroup[] => groups.map((group) => (group.id === groupId ? update(group) : group));

/** Entry edits never apply to the computed group, whose rows are derived. */
const withEntries = (
  groups: ChecklistGroup[],
  groupId: string,
  update: (entries: ChecklistSetting[]) => ChecklistSetting[]
): ChecklistGroup[] =>
  withGroup(groups, groupId, (group) =>
    group.kind === "computed" ? group : { ...group, entries: update(group.entries) }
  );

/** The lowest free "g-<n>" id. Seeded ids ("build"/"computed"/"ai") never collide. */
const nextGroupId = (groups: ChecklistGroup[]): string =>
  `g-${Math.max(0, ...groups.map((group) => Number(/^g-(\d+)$/.exec(group.id)?.[1] ?? 0))) + 1}`;

/** Reorders `entries` to match `order` (a list of first-ids); anything the order
 * does not name keeps its relative position at the end. */
const applyOrder = (entries: ChecklistSetting[], order: number[]): ChecklistSetting[] => {
  const byId = new Map(entries.map((entry) => [entry.ids[0], entry]));
  const ordered = order.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  return [...ordered, ...entries.filter((entry) => !order.includes(entry.ids[0]))];
};

/** The persisted shape before groups existed. */
type ChecklistStateV1 = { build?: ChecklistSetting[]; ai?: ChecklistSetting[] };

/**
 * v1 (`{build, ai}`) → v2 groups. The computed group is inserted between them,
 * which is exactly where the Builds tab renders those rows today, and every
 * group migrates auto-ordered — so an update moves nothing the user can see.
 * A missing or malformed list falls back to the bundled default for that group.
 */
export const migrateV1 = (persisted: ChecklistStateV1): ChecklistGroup[] => {
  const defaults = seed();
  const restore = (id: string, entries: ChecklistSetting[] | undefined): ChecklistGroup => {
    const base = defaults.find((group) => group.id === id)!;
    return Array.isArray(entries) ? { ...base, entries } : base;
  };
  return [
    restore("build", persisted?.build),
    defaults.find((group) => group.id === "computed")!,
    restore("ai", persisted?.ai),
  ];
};

export const useChecklistStore = create<ChecklistState>()(
  persist(
    (set) => ({
      groups: seed(),
      setLevel: (groupId, firstId, level) =>
        set((state) => ({
          groups: withEntries(state.groups, groupId, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, level } : entry))
          ),
        })),
      toggle: (groupId, firstId) =>
        set((state) => ({
          groups: withEntries(state.groups, groupId, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, enabled: !entry.enabled } : entry))
          ),
        })),
      remove: (groupId, firstId) =>
        set((state) => ({
          groups: withEntries(state.groups, groupId, (entries) => entries.filter((entry) => entry.ids[0] !== firstId)),
        })),
      add: (groupId, traitId, level) =>
        set((state) => ({
          groups: withEntries(state.groups, groupId, (entries) =>
            entries.some((entry) => entry.ids.includes(traitId))
              ? entries
              : [...entries, { ids: [traitId], level, enabled: true }]
          ),
        })),
      addGroup: (name) => {
        const id = nextGroupId(useChecklistStore.getState().groups);
        set((state) => ({
          groups: [...state.groups, { id, name, kind: "custom", enabled: true, manualOrder: false, entries: [] }],
        }));
        return id;
      },
      renameGroup: (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          groups: withGroup(state.groups, groupId, (group) => ({ ...group, name: trimmed, nameKey: undefined })),
        }));
      },
      removeGroup: (groupId) =>
        set((state) => ({
          groups: state.groups.filter((group) => group.id !== groupId || group.kind === "computed"),
        })),
      toggleGroup: (groupId) =>
        set((state) => ({
          groups: withGroup(state.groups, groupId, (group) => ({ ...group, enabled: !group.enabled })),
        })),
      reorderGroups: (from, to) => set((state) => ({ groups: moveItem(state.groups, from, to) })),
      reorderEntries: (groupId, order) =>
        set((state) => ({
          groups: withGroup(state.groups, groupId, (group) =>
            group.kind === "computed"
              ? group
              : { ...group, manualOrder: true, entries: applyOrder(group.entries, order) }
          ),
        })),
      moveEntry: (fromGroupId, toGroupId, firstId, order) =>
        set((state) => {
          if (fromGroupId === toGroupId) return {};
          const from = state.groups.find((group) => group.id === fromGroupId);
          const to = state.groups.find((group) => group.id === toGroupId);
          const entry = from?.entries.find((item) => item.ids[0] === firstId);
          if (!from || !to || !entry || to.kind === "computed") return {};
          // A trait may live in two groups, but not twice in one: reject rather
          // than merge, and the row snaps back where it came from.
          if (to.entries.some((item) => item.ids.some((id) => entry.ids.includes(id)))) return {};
          return {
            groups: state.groups.map((group) => {
              if (group.id === fromGroupId)
                return { ...group, entries: group.entries.filter((item) => item.ids[0] !== firstId) };
              if (group.id === toGroupId)
                return { ...group, manualOrder: true, entries: applyOrder([...group.entries, entry], order) };
              return group;
            }),
          };
        }),
      sortGroup: (groupId) =>
        set((state) => ({
          groups: withGroup(state.groups, groupId, (group) => ({ ...group, manualOrder: false })),
        })),
      reset: () => set({ groups: seed() }),
    }),
    {
      name: "checklist-settings",
      version: 2,
      migrate: (persisted, version) =>
        version >= 2
          ? (persisted as ChecklistState)
          : ({ groups: migrateV1(persisted as ChecklistStateV1) } as ChecklistState),
    }
  )
);

withStorageDOMEvents(useChecklistStore);
