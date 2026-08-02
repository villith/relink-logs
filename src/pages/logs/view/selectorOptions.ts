import type { SelectionFact } from "@/types";

import { abilityRowKey } from "./abilitySkills";
import { isStatusPin } from "./statusUptime";

/** The ability-row key a fact belongs to — the same key the table gives the row
 * this option pins, so picking from the list and clicking a row agree.
 *
 * A fact from a backend older than `childCharacterType` cannot be grouped: the
 * group is per child character, and guessing would file a summon's skill under
 * its owner. `abilityRowKey` already answers that way — a non-string child
 * groups to nothing — so such a fact stays its raw action, which is what the
 * list showed before grouping existed. */
const factRowKey = (fact: SelectionFact): string =>
  abilityRowKey({ actionType: fact.ability, childCharacterType: fact.childCharacterType ?? "" });

export type SelectorPins = {
  /** Source actor INDEX, or null for "All". The index rather than the
   * actor-type hash, so two players on the same character stay distinct — it
   * is also what `ComputedPlayerState.index` and the backend filter use. */
  source: number | null;
  /** Indices into `targetEntries` — one per pinned SPAWN; empty for "All".
   * Multi-select, matching today's enemy filter.
   *
   * Segment indices rather than actor ids, because the game reuses a dead
   * boss's id for a later one and an id therefore names two enemies. */
  targets: number[];
  /** `abilityKey()` value, or null for "All". */
  ability: string | null;
};

export type SelectorOption = { value: string };

export type SelectorOptions = {
  sources: SelectorOption[];
  targets: SelectorOption[];
  abilities: SelectorOption[];
};

/** A fact beside its row key, computed once. The three passes below each need
 * the key — deriving it per pass ran `abilityRowKey` (a group-map walk and a
 * `JSON.stringify`) three times over every fact on every pin click. */
type KeyedFact = { fact: SelectionFact; key: string };

/** Facts surviving every pin EXCEPT `ignore` — a dimension must never narrow
 * its own list, or a pinned value would be the only thing you could pick. */
const survivors = (facts: KeyedFact[], pins: SelectorPins, ignore: keyof SelectorPins) =>
  facts.filter(({ fact, key }) => {
    if (ignore !== "source" && pins.source !== null && fact.sourceIndex !== pins.source) return false;
    if (ignore !== "targets" && pins.targets.length > 0 && !pins.targets.includes(fact.targetSegment)) return false;
    // A status pin names an effect, and no damage fact's key can ever equal one
    // — narrowing by it would drop every fact and leave the Player and Enemy
    // selectors with no options at all. A buff narrows its own table, not the
    // fight's other dimensions.
    if (ignore !== "ability" && pins.ability !== null && !isStatusPin(pins.ability) && key !== pins.ability)
      return false;
    return true;
  });

/** Distinct values in first-seen order — the fact list already arrives in
 * event order, so this keeps the fight's own ordering rather than imposing one. */
const distinct = (values: string[]): SelectorOption[] => [...new Set(values)].map((value) => ({ value }));

/** Each selector's currently reachable options, given the other pins. */
export const deriveSelectorOptions = (facts: SelectionFact[], pins: SelectorPins): SelectorOptions => {
  const keyed: KeyedFact[] = facts.map((fact) => ({ fact, key: factRowKey(fact) }));

  return {
    sources: distinct(survivors(keyed, pins, "source").map(({ fact }) => String(fact.sourceIndex))),
    targets: distinct(survivors(keyed, pins, "targets").map(({ fact }) => String(fact.targetSegment))),
    abilities: distinct(survivors(keyed, pins, "ability").map(({ key }) => key)),
  };
};

