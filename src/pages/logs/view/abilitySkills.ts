import { skillGroupFor } from "@/components/skillGrouping";
import type { ActionType, CharacterType, SkillRow, SkillState } from "@/types";
import { isSupplementaryAction } from "@/utils";

import { abilityKey, parseAbilityKey, SUPPLEMENTARY_KEY } from "./abilityKey";
import { groupBy } from "./groupBy";

/** One ability row and every breakdown row behind it. */
export type AbilitySkills = { key: string; skills: SkillState[] };

/** Separates a group name from the child character it belongs to inside a pin
 * key. Not a colon: `abilityKey` already uses that as its name/payload split. */
const CHILD_SEPARATOR = "@";

/** The sentinel child for a group that deliberately spans body classes — only
 * Primal Burst, whose three classes share one action id. */
const ANY_CHILD = "*";

/** A set of breakdown rows' echo half, and whether the set holds both halves.
 *
 * `mixed` is the whole point: only a set holding BOTH has a split to report.
 * One that is echo all the way across — the echo row with the toggle off, or
 * the residue a collapse leaves behind — is already described by its own
 * label, and painting the whole bar in the fainter shade would say nothing.
 *
 * The one author of that rule for the RAW view. Four surfaces draw the same
 * split and must agree — a bar that split where the row beside it did not is
 * exactly what a second spelling buys:
 *
 * - the table's ability rows (`damageCells`),
 * - their per-player children (`damageCells` again, one grain down),
 * - the groups path's rows and members (`subValueOf`),
 * - the hover card's sections (`entrySplit`).
 *
 * The first three read the LANDING view's own figure under the collapse and
 * consult this only for the raw view: once an echo folds onto the hit that
 * caused it there is no echo row left in the set to find, so the backend
 * reports the share directly (`MergedMeasure.supplementary`,
 * `MergedSkillMeasure.supplementary`). The card has NOT moved — it still
 * computes its split from the raw totals here, which differs from the row
 * under the cursor wherever a filter or window orphans an echo. Recorded
 * rather than fixed in passing.
 *
 * No `direct` half any more. It existed to narrow a row's min and max to the
 * named skill's own hits, a rule the landing model replaces: under it an
 * extreme IS a whole landing, echo included, and only the backend can compute
 * one. */
export const splitSupplementary = <T extends SkillRow>(rows: T[]): { echoes: T[]; mixed: boolean } => {
  const echoes = rows.filter((row) => isSupplementaryAction(row.actionType));
  return { echoes, mixed: echoes.length > 0 && echoes.length < rows.length };
};

/** The echo share to draw as a bar's fainter segment, or nothing where there is
 * none — ABSENT rather than 0, so a row with no echoes mounts a single segment
 * instead of an empty second one.
 *
 * The LANDING view's spelling of the `mixed` test above, and its one author for
 * the same reason: the merged view reads the backend's own `supplementary`
 * figure, so it has no echo ROW to count and cannot ask `splitSupplementary`.
 * `supplementary < amount` is the part both views still share — a row that is
 * supplementary all the way across is already described by its own label, and
 * painting the whole bar fainter would say nothing. */
export const supplementarySubValue = (supplementary: number, amount: number): { subValue?: number } =>
  supplementary > 0 && supplementary < amount ? { subValue: supplementary } : {};

/** How rows are keyed for one view.
 *
 * Built once and passed down, so the table, the chart, the selector and the
 * timeline cannot disagree about which row an echo belongs to. Absent means
 * today's behaviour, which is what keeps every caller that does not care
 * (`selectorOptions`, `abilityLabel`, `rowIcon`) unchanged. */
export type RowKeying = {
  collapseSupplementary: boolean;
  /** The row key a cause id resolves to FOR ONE BODY, or null when that body
   * used no such action — which is what keeps an unattributable echo on the
   * echo row. Pass the echo's own `childCharacterType`; see `rowKeyingFor`. */
  causeRow: (causeId: number, body: CharacterType) => string | null;
  /** The ACTION that cause id names, one level below `causeRow`.
   *
   * A row is where an echo belongs; this is which of that row's member skills
   * it belongs to. Only a skill-GROUP row has members, and listing an echo
   * beside them as a member of its own says the group contains a skill it does
   * not — while dropping it would stop the children summing to the parent they
   * expand. Folded onto its cause, both hold. */
  causeAction: (causeId: number, body: CharacterType) => ActionType | null;
};

/** One entry in the cause index: a body and the action id it used.
 *
 * **A cause id means nothing on its own.** Skill ids are numbered per character:
 * `Normal(100)` is Id's first normal attack, Percival's, and Id's dragon form's,
 * and `Normal(130)` is a member of Eustace's normal-attack group while every
 * other character leaves it ungrouped. Keyed by the bare id across the party,
 * the last body to use it named the row for all of them — which put one player's
 * echoes on another player's row ("Normal Attack (Percival)" under Id), and put
 * the rest on raw-action rows standing beside the very group they belong to (a
 * second "Grade 4 Shot" under Eustace).
 *
 * The echo's own body is the right scope: an echo is dealt by the same actor as
 * the hit that triggered it, so the parser files both under one
 * `childCharacterType` (`child_character_type_for`). */
const causeIndexKey = (body: CharacterType, causeId: number): string => `${JSON.stringify(body)}:${causeId}`;

/** The keying for one view, from what the party actually used.
 *
 * Derived from the observed actions rather than a lookup table, for the same
 * reason `actionsForPin` is: it cannot claim a cause nobody landed. */
export const rowKeyingFor = (skills: SkillRow[], collapse: boolean): RowKeying => {
  // Row and action together, from ONE scan: they answer the same question at
  // two levels, and two scans is how they would come to name different causes.
  //
  // Last writer wins and cannot matter: `abilityRowKey` is a function of
  // (action, body) alone, so every entry under one index key agrees.
  const byCause = new Map<string, { row: string; action: ActionType }>();
  if (collapse) {
    for (const skill of skills) {
      const action = skill.actionType;
      if (typeof action !== "object" || !("Normal" in action)) continue;
      byCause.set(causeIndexKey(skill.childCharacterType, action.Normal), { row: abilityRowKey(skill), action });
    }
  }
  return {
    collapseSupplementary: collapse,
    causeRow: (causeId, body) => byCause.get(causeIndexKey(body, causeId))?.row ?? null,
    causeAction: (causeId, body) => byCause.get(causeIndexKey(body, causeId))?.action ?? null,
  };
};

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
export const abilityRowKey = (skill: SkillRow, keying?: RowKeying): string => {
  // Echoes fold first: ungrouped by nature, and without collapse keying every
  // one of them is the same row (see `SUPPLEMENTARY_KEY`). With it, an echo
  // rides the row of the skill that caused it — and falls back to the echo row
  // when that cause names nothing the party used.
  if (isSupplementaryAction(skill.actionType)) {
    if (keying?.collapseSupplementary !== true) return SUPPLEMENTARY_KEY;
    const causeId = (skill.actionType as { SupplementaryDamage: number }).SupplementaryDamage;
    return keying.causeRow(causeId, skill.childCharacterType) ?? SUPPLEMENTARY_KEY;
  }

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
export const groupSkillsForRows = (skills: SkillState[], keying?: RowKeying): AbilitySkills[] =>
  foldBy(skills, (skill) => abilityRowKey(skill, keying));

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
export const skillsForAbilityKey = <T extends SkillRow>(skills: T[], key: string, keying?: RowKeying): T[] =>
  skills.filter((skill) => abilityRowKey(skill, keying) === key);

/** The raw actions a pinned ability row stands for, for the backend's filter.
 *
 * Expanded from what the party ACTUALLY used rather than from the group table:
 * that keeps the parser free of a display concern it has never known about, and
 * it is exact — it cannot widen the filter to ids nobody landed, and it handles
 * the cases no table lookup could (Primal Burst's shared id, Ferry's remapped
 * pet actions).
 *
 * **Pass the breakdown rows AND the selection facts.** The echo ROW is a display
 * fold over dozens of `SupplementaryDamage(n)` payloads and its key carries only
 * the canonical one, so expanding the pin from the key alone filtered to that
 * single payload and reported a quarter of the row's damage as its whole. The
 * facts carry every distinct action, which is what makes the expansion complete.
 *
 * Falls back to the key's own action when nothing matches, because an empty list
 * reads as "every ability" at the backend and would silently drop the filter. */
export const actionsForPin = (key: string, skills: SkillRow[], keying?: RowKeying): ActionType[] => {
  const actions = new Map<string, ActionType>();
  for (const skill of skillsForAbilityKey(skills, key, keying)) {
    actions.set(abilityKey(skill.actionType), skill.actionType);
  }
  return actions.size > 0 ? [...actions.values()] : pinFallback(key);
};

/** What a pin stands for when NO observed hit keys to it. Shared by the two
 * expansions below so a row the timeline resolves and the same row the backend
 * filter resolves cannot fall back differently. */
const pinFallback = (key: string): ActionType[] => {
  const parsed = parseAbilityKey(key);
  // A group that matched nothing has no raw action to fall back to; the caller
  // sees an empty filter, which is the same thing the empty table shows.
  return parsed === null || groupOfPin(key) !== null ? [] : [parsed];
};

/** `actionsForPin` for a whole table's worth of rows, in ONE pass.
 *
 * The same expansion and the same fallback — but keyed forward off the skills
 * instead of filtered backward per row. `actionsForPin` rescans every skill for
 * every key, computing a row key per entry; the timeline's lane index asks for
 * every ability row at once, so that is rows × skills row-key computations each
 * time the index is built. This is rows + skills. */
export const actionsForPins = (keys: string[], skills: SkillRow[], keying?: RowKeying): Map<string, ActionType[]> => {
  const byRow = new Map<string, Map<string, ActionType>>();
  for (const skill of skills) {
    const rowKey = abilityRowKey(skill, keying);
    let actions = byRow.get(rowKey);
    if (actions === undefined) {
      actions = new Map<string, ActionType>();
      byRow.set(rowKey, actions);
    }
    actions.set(abilityKey(skill.actionType), skill.actionType);
  }

  const expanded = new Map<string, ActionType[]>();
  for (const key of keys) {
    const actions = byRow.get(key);
    expanded.set(key, actions === undefined ? pinFallback(key) : [...actions.values()]);
  }
  return expanded;
};
