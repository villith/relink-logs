import SkillGroupMapping from "@/assets/skill-groups";
import type { CharacterType, SkillRow } from "@/types";
import { PRIMAL_BURST_GROUP, isPrimalBurstHit } from "@/utils";

/** The condensed row a skill folds into: a group name, scoped to the child
 * character that owns it. A null child means the group spans classes. */
export type SkillGroupKey = { group: string; childCharacterType: CharacterType | null };

/** Which condensed group a skill belongs to, or null when it stays itself.
 *
 * The single rule behind both condensed views — Classic's skill table and the
 * analysis chart's stacked bands — so a band and a row can never disagree about
 * what belongs together. Four things it gets right that a fresh implementation
 * would not:
 *
 * - **Only `Normal(n)` actions group.** Link attacks, SBAs, echoes, DoT ticks
 *   and stun rows stay themselves; the map is keyed by skill id and has nothing
 *   to say about them.
 * - **Groups are scoped to `childCharacterType`, not the parent** — a pet's
 *   skills group separately from its owner's, and the map is per character.
 * - **Primal Burst is special**: its three body classes share one action id, so
 *   no per-character map can join them. They match on the body class and carry a
 *   null child so the three still land in one group.
 * - **An action in no group stays itself.** The map is not exhaustive; ids in
 *   the global namespace (>= 99999) are not character skills at all.
 *
 * Whether to condense is the CALLER's decision — Classic asks
 * `use_condensed_skills`, the analysis chart always condenses because an
 * ungrouped stack is unreadable. This function only answers where a skill goes. */
export const skillGroupFor = (skill: SkillRow): SkillGroupKey | null => {
  if (isPrimalBurstHit(skill)) return { group: PRIMAL_BURST_GROUP, childCharacterType: null };

  if (typeof skill.actionType !== "object" || !Object.hasOwn(skill.actionType, "Normal")) return null;

  // An unresolved child (a `{ Unknown: hash }` body that is not a Primal Burst)
  // has no map of its own; leaving it ungrouped is the honest answer.
  if (typeof skill.childCharacterType !== "string") return null;

  const id = (skill.actionType as { Normal: number }).Normal;
  const mapping = SkillGroupMapping[skill.childCharacterType] || {};

  for (const group in mapping) {
    if (mapping[group].skills.includes(id)) {
      return { group, childCharacterType: skill.childCharacterType };
    }
  }

  return null;
};

