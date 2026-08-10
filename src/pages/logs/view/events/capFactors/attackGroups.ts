import coverage from "@/assets/attack-group-coverage.json";

/**
 * The per-character attack-group coverage registry, as the factor evaluation
 * reads it.
 *
 * Group-scoped board cap nodes carry only a per-character group NUMBER whose
 * membership lives in engine code, so it is derived empirically from
 * instrumented local play and banked in `attack-group-coverage.json` (see
 * `scripts/gen-attack-group-coverage.mjs` for the whole story). This module is
 * the one reader: a derived membership settles a group-scoped row against a
 * hit's action id; an underived group leaves it honestly unresolved.
 */

type Membership = { actionIds: number[]; evidence: string };
type CharacterCoverage = {
  status: string;
  neededGroups: number[];
  groups: Record<string, Membership>;
};
export type AttackGroupCoverage = Record<string, CharacterCoverage>;

let characters = coverage.characters as AttackGroupCoverage;

/** Replaces the registry — for tests, and for a future live-derivation
 * preview. Production reads the shipped asset. */
export const setAttackGroupCoverage = (next: AttackGroupCoverage): void => {
  characters = next;
};

/** The derived action ids of one character's attack group, or `null` while
 * that group's membership is still underived. `null` never means "no actions"
 * — an underived group is a question, not an empty set. */
export const groupActionIds = (characterType: string, groupId: number): number[] | null =>
  characters[characterType.toLowerCase()]?.groups[String(groupId)]?.actionIds ?? null;
