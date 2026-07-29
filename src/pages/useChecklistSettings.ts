import { useChecklistStore } from "@/stores/useChecklistStore";
import { getTraitsBundle } from "@/utils";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

/** Level assigned to entries added from the Settings picker. */
export const NEW_ENTRY_LEVEL = 15;

/**
 * State + handlers for Settings → Checklist: the group list, a searchable trait
 * picker per group, and the group/entry mutations the editor drives.
 */
export default function useChecklistSettings() {
  // The `traits` namespace is already eagerly preloaded (src/i18n.ts `ns`
  // list); this call is kept so the component re-renders via bindI18nStore
  // when the bundle loads or the language changes.
  useTranslation("traits");
  const store = useChecklistStore(
    useShallow((state) => ({
      groups: state.groups,
      setLevel: state.setLevel,
      toggle: state.toggle,
      remove: state.remove,
      add: state.add,
      addGroup: state.addGroup,
      renameGroup: state.renameGroup,
      removeGroup: state.removeGroup,
      toggleGroup: state.toggleGroup,
      reorderGroups: state.reorderGroups,
      reorderEntries: state.reorderEntries,
      moveEntry: state.moveEntry,
      sortGroup: state.sortGroup,
      reset: state.reset,
    }))
  );

  // All known traits as Select options ("<hex>" value, translated label), minus
  // traits already present in ANY entry's id group of THAT group (matching the
  // store's add() no-op semantics, which also reject secondary group members).
  // Recomputed per render — the bundle only changes on language switch and the
  // lists are small.
  const traitOptions = (groupId: string): { value: string; label: string }[] => {
    const bundle = getTraitsBundle();
    const group = store.groups.find((item) => item.id === groupId);
    const present = new Set((group?.entries ?? []).flatMap((entry) => entry.ids));
    return Object.entries(bundle)
      .filter(([hex, value]) => Boolean(value?.text) && !present.has(parseInt(hex, 16)))
      .map(([hex, value]) => ({ value: hex, label: value.text as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const addTrait = (groupId: string, hex: string | null) => {
    if (!hex) return;
    store.add(groupId, parseInt(hex, 16), NEW_ENTRY_LEVEL);
  };

  const setEntryLevel = (groupId: string, firstId: number, value: number | string) => {
    const level = typeof value === "number" ? value : parseInt(value, 10);
    if (!Number.isFinite(level)) return;
    store.setLevel(groupId, firstId, Math.max(1, Math.round(level)));
  };

  return { ...store, traitOptions, addTrait, setEntryLevel };
}
