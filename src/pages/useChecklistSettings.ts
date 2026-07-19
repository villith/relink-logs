import { useChecklistStore, type ChecklistGroup } from "@/stores/useChecklistStore";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

/** Level assigned to entries added from the Settings picker. */
export const NEW_ENTRY_LEVEL = 15;

/**
 * State + handlers for the Settings "Checklist" fieldset: the two editable
 * entry lists and a searchable trait picker per group, fed from the loaded
 * i18next `traits` bundle.
 */
export default function useChecklistSettings() {
  // The `traits` namespace is already eagerly preloaded (src/i18n.ts `ns`
  // list); this call is kept so the component re-renders via bindI18nStore
  // when the bundle loads or the language changes.
  useTranslation("traits");
  const { build, ai, setLevel, toggle, remove, add, reset } = useChecklistStore(
    useShallow((state) => ({
      build: state.build,
      ai: state.ai,
      setLevel: state.setLevel,
      toggle: state.toggle,
      remove: state.remove,
      add: state.add,
      reset: state.reset,
    }))
  );

  // All known traits as Select options ("<hex>" value, translated label),
  // minus traits already present in ANY entry's id group (matching the
  // store's add() no-op semantics, which also reject secondary group
  // members). Recomputed per render — the bundle only changes on language
  // switch and the lists are small.
  const traitOptions = (group: ChecklistGroup): { value: string; label: string }[] => {
    const bundle = getTraitsBundle();
    const present = new Set((group === "build" ? build : ai).flatMap((entry) => entry.ids));
    return Object.entries(bundle)
      .filter(([hex, value]) => Boolean(value?.text) && !present.has(parseInt(hex, 16)))
      .map(([hex, value]) => ({ value: hex, label: value.text as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const addTrait = (group: ChecklistGroup, hex: string | null) => {
    if (!hex) return;
    add(group, parseInt(hex, 16), NEW_ENTRY_LEVEL);
  };

  const setEntryLevel = (group: ChecklistGroup, firstId: number, value: number | string) => {
    const level = typeof value === "number" ? value : parseInt(value, 10);
    if (!Number.isFinite(level)) return;
    setLevel(group, firstId, Math.max(1, Math.round(level)));
  };

  return { build, ai, toggle, remove, reset, traitOptions, addTrait, setEntryLevel };
}
