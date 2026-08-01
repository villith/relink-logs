import type { SelectionFact } from "@/types";

import { abilityKey } from "./abilityKey";

export type SelectorPins = {
  /** Source actor INDEX, or null for "All". The index rather than the
   * actor-type hash, so two players on the same character stay distinct — it
   * is also what `ComputedPlayerState.index` and the backend filter use. */
  source: number | null;
  /** Target instance ids; empty for "All". Multi-select, matching today's enemy filter. */
  targetIds: number[];
  /** `abilityKey()` value, or null for "All". */
  ability: string | null;
};

export type SelectorOption = { value: string };

export type SelectorOptions = {
  sources: SelectorOption[];
  targets: SelectorOption[];
  abilities: SelectorOption[];
};

/** Facts surviving every pin EXCEPT `ignore` — a dimension must never narrow
 * its own list, or a pinned value would be the only thing you could pick. */
const survivors = (facts: SelectionFact[], pins: SelectorPins, ignore: keyof SelectorPins) =>
  facts.filter((f) => {
    if (ignore !== "source" && pins.source !== null && f.sourceIndex !== pins.source) return false;
    if (ignore !== "targetIds" && pins.targetIds.length > 0 && !pins.targetIds.includes(f.targetId)) return false;
    if (ignore !== "ability" && pins.ability !== null && abilityKey(f.ability) !== pins.ability) return false;
    return true;
  });

/** Distinct values in first-seen order — the fact list already arrives in
 * event order, so this keeps the fight's own ordering rather than imposing one. */
const distinct = (values: string[]): SelectorOption[] => [...new Set(values)].map((value) => ({ value }));

/** Each selector's currently reachable options, given the other pins. */
export const deriveSelectorOptions = (facts: SelectionFact[], pins: SelectorPins): SelectorOptions => ({
  sources: distinct(survivors(facts, pins, "source").map((f) => String(f.sourceIndex))),
  targets: distinct(survivors(facts, pins, "targetIds").map((f) => String(f.targetId))),
  abilities: distinct(survivors(facts, pins, "ability").map((f) => abilityKey(f.ability))),
});
