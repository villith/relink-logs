import type { SelectionFact } from "@/types";

import { abilityRowKey } from "./abilitySkills";
import type { Hostility } from "./metrics/types";
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

/** A fact beside its row key AND its two actors under the current side, computed
 * once. The three passes below each need all three — deriving the key per pass
 * ran `abilityRowKey` (a group-map walk and a `JSON.stringify`) three times over
 * every fact on every pin click.
 *
 * `source`/`target` are the fact's actors in the ROLES the current side gives
 * them, not the fields it stores them in. A fact always records the hit as it
 * was dealt — a player hitting an enemy spawn — but the side toggle swaps which
 * of those two the source dimension names (see `universeOf`): on the enemy side
 * the source selector offers enemy spawns and the target selector offers the
 * party. Read straight off the fields, both selectors offered the friendly
 * universes on both sides, which is why the toggle appeared to do nothing to
 * them. */
type KeyedFact = { source: number; target: number; key: string };

/** Facts surviving every pin EXCEPT `ignore` — a dimension must never narrow
 * its own list, or a pinned value would be the only thing you could pick. */
const survivors = (facts: KeyedFact[], pins: SelectorPins, ignore: keyof SelectorPins) =>
  facts.filter(({ source, target, key }) => {
    if (ignore !== "source" && pins.source !== null && source !== pins.source) return false;
    if (ignore !== "targets" && pins.targets.length > 0 && !pins.targets.includes(target)) return false;
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

/** Each selector's currently reachable options, given the other pins.
 *
 * `hostility` is the ROLE MAPPING, not a filter: on the friendly side a fact's
 * player is the source and the spawn it hit is the target; on the enemy side the
 * two swap, exactly as `universeOf` and the backend's own group query swap them.
 * Every value here therefore already means what the pin holding it means — a
 * source pin is a player index on one side and a spawn segment on the other —
 * so the cascade narrows the right dimension either way. */
export const deriveSelectorOptions = (
  facts: SelectionFact[],
  pins: SelectorPins,
  hostility: Hostility = "friendly"
): SelectorOptions => {
  const swapped = hostility === "enemy";
  const keyed: KeyedFact[] = facts.map((fact) => ({
    source: swapped ? fact.targetSegment : fact.sourceIndex,
    target: swapped ? fact.sourceIndex : fact.targetSegment,
    key: factRowKey(fact),
  }));

  return {
    sources: distinct(survivors(keyed, pins, "source").map(({ source }) => String(source))),
    targets: distinct(survivors(keyed, pins, "targets").map(({ target }) => String(target))),
    abilities: distinct(survivors(keyed, pins, "ability").map(({ key }) => key)),
  };
};
