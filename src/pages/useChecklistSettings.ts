import { useChecklistStore } from "@/stores/useChecklistStore";
import { getTraitsBundle } from "@/utils";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

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
  // `groups` is the store's only state — every other member is an action, whose
  // identity zustand fixes at creation — so subscribing to the whole store is
  // exactly as narrow as listing the actions one by one, and does not need
  // editing each time one is added.
  const store = useChecklistStore();

  // Every known trait as a Select option ("<hex>" value, translated label),
  // sorted once per bundle rather than once per group per render: only the
  // per-group exclusion below differs between the pickers.
  const bundle = getTraitsBundle();
  const allTraitOptions = useMemo(
    () =>
      Object.entries(bundle)
        .filter(([, value]) => Boolean(value?.text))
        .map(([hex, value]) => ({ value: hex, label: value.text as string, id: parseInt(hex, 16) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [bundle]
  );

  // Minus traits already present in ANY entry's id group of THAT group (matching
  // the store's add() no-op semantics, which also reject secondary group members).
  const traitOptions = (groupId: string): { value: string; label: string }[] => {
    const group = store.groups.find((item) => item.id === groupId);
    const present = new Set((group?.entries ?? []).flatMap((entry) => entry.ids));
    return allTraitOptions.filter((option) => !present.has(option.id)).map(({ value, label }) => ({ value, label }));
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
