import { abilityIconForAction } from "@/abilityIcon";
import SkillGroupMapping from "@/assets/skill-groups";
import { skillGroupFor } from "@/components/skillGrouping";
import type { CharacterType, SkillRow } from "@/types";

import { abilityKey } from "../abilityKey";
import { abilityRowKey } from "../abilitySkills";

/** The party fields icon resolution needs — narrower than the label's player
 * so tests (and future callers) need not fabricate full damage figures. */
export type IconRowPlayer = { characterType: CharacterType; skillBreakdown: SkillRow[] };

/** Whether a breakdown row is one the given key names.
 *
 * BOTH grammars, because the view addresses an ability by two different keys
 * and both must reach the same picture:
 *
 * - the ROW key (`abilityRowKey`), which condenses a grouped skill into its
 *   group — what the table's rows and the chart's bands carry;
 * - the RAW ACTION key (`abilityKey`), which does not — what the hover card's
 *   ability fold carries, deliberately (see `foldPartyDealt`: that card has
 *   always listed raw actions rather than condensed groups).
 *
 * Matching row keys alone left every GROUPED action in that card text-only:
 * Percival's "Zerreissen (Empowered)" is action 40, whose row key is
 * `Group:zerreissen@…`, so `Normal:40` matched nothing. The two forms cannot
 * collide — a group key is `Group:<name>@<child>` and an action key never is —
 * so accepting both widens nothing else.
 *
 * Deliberately NOT done by widening `skillsForAbilityKey`, which this used to
 * call: that function also decides what a PIN expands to (`actionsForPin`), and
 * a pin that suddenly matched raw actions as well as rows would change which
 * damage the backend filters to. */
const namesSkill = (skill: SkillRow, key: string): boolean =>
  abilityRowKey(skill) === key || abilityKey(skill.actionType) === key;

/** Every action id in the skill group a row belongs to, or an empty list when
 * it belongs to none. The group's membership is a static fact about the
 * character, not about what this fight used — so a follow-up that landed
 * alone still finds the sibling carrying the art. */
const groupActionIds = (skill: SkillRow): number[] => {
  const group = skillGroupFor(skill);
  if (group === null || typeof group.childCharacterType !== "string") return [];
  return SkillGroupMapping[group.childCharacterType]?.[group.group]?.skills ?? [];
};

/** The art for one action, tried against the child body first and then the
 * player's own — the exact fall-through `getSkillName` resolves the NAME with.
 * Unknown-hash bodies have no map either way. */
const iconForAction = (action: number, skill: SkillRow, player: IconRowPlayer): string | undefined => {
  for (const character of [skill.childCharacterType, player.characterType]) {
    if (typeof character !== "string" || character === "") continue;
    const url = abilityIconForAction(character, action);
    if (url) return url;
  }
  return undefined;
};

/**
 * Ability art for one ability ROW, resolved the same way the row is named.
 *
 * A row key carries no action id of its own — a group row spans several — so
 * the icon comes from the breakdown rows behind it: the first member action
 * with art names the row. The same owner-preference as `abilityLabelFor`, and
 * for the same reason: action ids collide across characters, so the pinned
 * player's own actions must resolve against their character, not the first
 * party member to share an id.
 *
 * The child character wins where a hit has one — Id's dragonform actions are
 * attributed to the Pl1900 player but their art belongs to Pl2000, exactly as
 * the ability map keys them.
 *
 * Two passes, because a member of a skill group may have no art of its own
 * while the group does: Id's Reginleiv Recidive Combo continues the ability
 * whose diamond the row already wears, and the game gives the follow-up none.
 * The action's own art wins; the GROUP's stands in only where there is none.
 * That fallback runs off the group table rather than the breakdown, so it does
 * not depend on the sibling having been used in this fight.
 *
 * `undefined` is data: bare kinds (link attacks, SBA, echoes, DoT) and combo
 * actions are not ability casts and have no diamond to show — and neither do
 * the charged normal attacks that carry their own names, whose whole group is
 * art-less (Percival's Schlacht).
 */
export const abilityRowIconUrl = (
  key: string,
  players: IconRowPlayer[],
  preferred?: IconRowPlayer
): string | undefined => {
  const roster = preferred ? [preferred, ...players] : players;

  // Pass 1: the action's own art.
  for (const player of roster) {
    for (const skill of player.skillBreakdown) {
      if (!namesSkill(skill, key)) continue;
      if (typeof skill.actionType !== "object" || !("Normal" in skill.actionType)) continue;
      const url = iconForAction(skill.actionType.Normal, skill, player);
      if (url) return url;
    }
  }

  // Pass 2: the art of the group it belongs to — the parent's picture, for a
  // member the game drew no diamond for.
  for (const player of roster) {
    for (const skill of player.skillBreakdown) {
      if (!namesSkill(skill, key)) continue;
      for (const action of groupActionIds(skill)) {
        const url = iconForAction(action, skill, player);
        if (url) return url;
      }
    }
  }

  return undefined;
};
