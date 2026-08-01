import { skillGroupFor } from "@/components/skillGrouping";
import type { ActionType, SkillState } from "@/types";

import { abilityKey, parseAbilityKey } from "./abilityKey";

/** One ability row and every breakdown row behind it. */
export type AbilitySkills = { key: string; skills: SkillState[] };

/** Separates a group name from the child character it belongs to inside a pin
 * key. Not a colon: `abilityKey` already uses that as its name/payload split. */
const CHILD_SEPARATOR = "@";

/** The sentinel child for a group that deliberately spans body classes — only
 * Primal Burst, whose three classes share one action id. */
const ANY_CHILD = "*";

/** The key identifying the ability row a skill belongs to.
 *
 * The analysis view always condenses, so a grouped skill's row is its GROUP.
 * Two things this gets right:
 *
 * - **A group key carries its child character.** One player can hold two group
 *   rows of the same name: Id's own and his dragon form's share `normal-attack`,
 *   `aerial-attack` and `reginleiv`, and dragon damage is attributed to the Id
 *   player. Keyed by name alone the two rows would merge, and pinning one would
 *   pull in the other's damage.
 * - **An ungrouped skill is keyed by its action ALONE**, deliberately dropping
 *   the child. The parser emits one breakdown row per `(action, child)`, so a
 *   player and their summon using one action id are two rows of a single
 *   ability — merging them is what stops the table drawing it twice with the
 *   damage split (the defect 68e148c fixed in the hover card).
 *
 * The result doubles as the `ability` pin, so it must stay URL-safe. */
export const abilityRowKey = (skill: SkillState): string => {
  const group = skillGroupFor(skill);
  if (group === null) return abilityKey(skill.actionType);

  const child = group.childCharacterType === null ? ANY_CHILD : JSON.stringify(group.childCharacterType);
  return `${abilityKey({ Group: group.group })}${CHILD_SEPARATOR}${child}`;
};

/** The group name inside a pin key, or null when the key names a raw action.
 *
 * Naming a group row goes through this: `getSkillName` resolves
 * `{ Group: "power-raise" }`, and would render the raw key for anything else. */
export const groupOfPin = (key: string): string | null => {
  const action = parseAbilityKey(key);
  if (action === null || typeof action !== "object" || !("Group" in action)) return null;
  const [group] = action.Group.split(CHILD_SEPARATOR);
  return group;
};

/** A player's `skillBreakdown` as ability rows, in first-seen order. */
export const groupSkillsForRows = (skills: SkillState[]): AbilitySkills[] => {
  const byKey = new Map<string, AbilitySkills>();
  for (const skill of skills) {
    const key = abilityRowKey(skill);
    const found = byKey.get(key);
    if (found) found.skills.push(skill);
    else byKey.set(key, { key, skills: [skill] });
  }
  return [...byKey.values()];
};

/** A breakdown as one row per ACTION, in first-seen order.
 *
 * The level below the abilities level: a pinned group's members, so grouping is
 * exactly what must not happen here — folding them back would redraw the row
 * that was just clicked.
 *
 * Merged by action id alone, deliberately dropping the child character, for the
 * same reason `abilityRowKey` drops it for an ungrouped skill: a player and
 * their summon using one action id are two breakdown rows of a single skill, and
 * keeping them apart would draw it twice with its damage split. */
export const mergeSkillsByAction = (skills: SkillState[]): AbilitySkills[] => {
  const byKey = new Map<string, AbilitySkills>();
  for (const skill of skills) {
    const key = abilityKey(skill.actionType);
    const found = byKey.get(key);
    if (found) found.skills.push(skill);
    else byKey.set(key, { key, skills: [skill] });
  }
  return [...byKey.values()];
};

/** Every breakdown row behind one ability row.
 *
 * Prefer this over `find`: a single row is one contributor's share, so
 * explaining a row with it describes a fraction of what the row reports. */
export const skillsForAbilityKey = (skills: SkillState[], key: string): SkillState[] =>
  skills.filter((skill) => abilityRowKey(skill) === key);

/** The raw actions a pinned ability row stands for, for the backend's filter.
 *
 * Expanded from what the player ACTUALLY used rather than from the group table:
 * that keeps the parser free of a display concern it has never known about, and
 * it is exact — it cannot widen the filter to ids this player never landed, and
 * it handles the cases no table lookup could (Primal Burst's shared id, Ferry's
 * remapped pet actions).
 *
 * Falls back to the key's own action when nothing matches, because an empty list
 * reads as "every ability" at the backend and would silently drop the filter. */
export const actionsForPin = (key: string, skills: SkillState[]): ActionType[] => {
  const actions = new Map<string, ActionType>();
  for (const skill of skillsForAbilityKey(skills, key)) {
    actions.set(abilityKey(skill.actionType), skill.actionType);
  }
  if (actions.size > 0) return [...actions.values()];

  const parsed = parseAbilityKey(key);
  // A group that matched nothing has no raw action to fall back to; the caller
  // sees an empty filter, which is the same thing the empty table shows.
  return parsed === null || groupOfPin(key) !== null ? [] : [parsed];
};
