import { skillGroupFor } from "@/components/skillGrouping";
import type { ActionType, CharacterType, SkillRow, SkillState } from "@/types";

import { abilityKey, parseAbilityKey } from "./abilityKey";
import { groupBy } from "./groupBy";

/** One ability row and every breakdown row behind it. */
export type AbilitySkills = { key: string; skills: SkillState[] };

/** Separates a group name from the child character it belongs to inside a pin
 * key. Not a colon: `abilityKey` already uses that as its name/payload split. */
const CHILD_SEPARATOR = "@";

/** The sentinel child for a group that deliberately spans body classes — only
 * Primal Burst, whose three classes share one action id. */
const ANY_CHILD = "*";

/** The one key every supplementary-damage hit folds onto.
 *
 * The parser folds ALL echoes onto a single breakdown row whatever their payload
 * or body (`BreakdownKeying::first_supplementary`), so the row key must fold the
 * same way or the two disagree — a selector listing 24 entries that all read
 * "Supplementary Damage", each pinning a quarter of the row it names.
 *
 * The payload is normalised to 0 rather than dropped so the key still parses:
 * `getSkillName` names every echo from the variant alone, so a canonical payload
 * reads exactly as the row does. */
const SUPPLEMENTARY_ROW: ActionType = { SupplementaryDamage: 0 };

/** Whether an action is a supplementary-damage (echo) hit. */
const isSupplementary = (actionType: ActionType): boolean =>
  typeof actionType === "object" && Object.hasOwn(actionType, "SupplementaryDamage");

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
export const abilityRowKey = (skill: SkillRow): string => {
  // Echoes fold first: they are never grouped, and every one of them is the
  // same row (see `SUPPLEMENTARY_ROW`).
  if (isSupplementary(skill.actionType)) return abilityKey(SUPPLEMENTARY_ROW);

  const group = skillGroupFor(skill);
  if (group === null) return abilityKey(skill.actionType);

  const child = group.childCharacterType === null ? ANY_CHILD : JSON.stringify(group.childCharacterType);
  return `${abilityKey({ Group: group.group })}${CHILD_SEPARATOR}${child}`;
};

/** The display name of the ability ROW a hit belongs to.
 *
 * A grouped hit is named by its GROUP — `getSkillName` resolves `{ Group }` to
 * `skills.<character>.skill-groups.<group>`, and naming it from the hit itself
 * would print one member skill's name over a row that holds several, while
 * naming it from the raw key would print "power-raise" at the user.
 *
 * Shared by the analysis view's ability pin and its drill-down legend, which is
 * the pair that must never disagree: the same row is the thing you click and the
 * band you then look at.
 *
 * `skillName` is injected rather than imported so this stays pure; callers pass
 * `getSkillName` and re-derive on a language change. */
export const abilityRowName = (
  characterType: CharacterType,
  skill: SkillRow,
  skillName: (characterType: CharacterType, skill: SkillRow) => string
): string => {
  const group = skillGroupFor(skill);
  if (group === null) return skillName(characterType, skill);
  return skillName(characterType, { ...skill, actionType: { Group: group.group } });
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

/** The child character a group pin carries, or null for a raw action key, a
 * body-spanning group (`ANY_CHILD`), or anything malformed.
 *
 * The reading half of `abilityRowKey`'s child suffix, exactly as `groupOfPin`
 * is of its name — the label qualifier reads it to tell "Normal Attack (Id)"
 * from "Normal Attack (Eustace)", which the group NAME alone cannot. */
export const childOfPin = (key: string): CharacterType | null => {
  const action = parseAbilityKey(key);
  if (action === null || typeof action !== "object" || !("Group" in action)) return null;
  const [, child] = action.Group.split(CHILD_SEPARATOR);
  if (child === undefined || child === ANY_CHILD) return null;
  try {
    return JSON.parse(child) as CharacterType;
  } catch {
    return null;
  }
};

const foldBy = (skills: SkillState[], keyOf: (skill: SkillState) => string): AbilitySkills[] =>
  [...groupBy(skills, keyOf)].map(([key, grouped]) => ({ key, skills: grouped }));

/** A player's `skillBreakdown` as ability rows, in first-seen order. */
export const groupSkillsForRows = (skills: SkillState[]): AbilitySkills[] => foldBy(skills, abilityRowKey);

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
export const mergeSkillsByAction = (skills: SkillState[]): AbilitySkills[] =>
  foldBy(skills, (skill) => abilityKey(skill.actionType));

/** Every breakdown row behind one ability row.
 *
 * Prefer this over `find`: a single row is one contributor's share, so
 * explaining a row with it describes a fraction of what the row reports. */
export const skillsForAbilityKey = <T extends SkillRow>(skills: T[], key: string): T[] =>
  skills.filter((skill) => abilityRowKey(skill) === key);

/** The raw actions a pinned ability row stands for, for the backend's filter.
 *
 * Expanded from what the party ACTUALLY used rather than from the group table:
 * that keeps the parser free of a display concern it has never known about, and
 * it is exact — it cannot widen the filter to ids nobody landed, and it handles
 * the cases no table lookup could (Primal Burst's shared id, Ferry's remapped
 * pet actions).
 *
 * **Pass the breakdown rows AND the selection facts.** A breakdown row carries
 * only the payload the parser folded that row onto, so the echo row alone names
 * one `SupplementaryDamage(n)` out of the dozens behind it — filtering on that
 * reported a quarter of the row's damage as its whole. The facts carry every
 * distinct action, which is what makes the expansion complete.
 *
 * Falls back to the key's own action when nothing matches, because an empty list
 * reads as "every ability" at the backend and would silently drop the filter. */
export const actionsForPin = (key: string, skills: SkillRow[]): ActionType[] => {
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
