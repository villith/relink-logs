import { abilityIconForAction } from "@/abilityIcon";
import type { CharacterType, SkillRow } from "@/types";

import { skillsForAbilityKey } from "../abilitySkills";

/** The party fields icon resolution needs — narrower than the label's player
 * so tests (and future callers) need not fabricate full damage figures. */
export type IconRowPlayer = { characterType: CharacterType; skillBreakdown: SkillRow[] };

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
 * `undefined` is data: bare kinds (link attacks, SBA, echoes, DoT) and combo
 * actions are not ability casts and have no diamond to show.
 */
export const abilityRowIconUrl = (
  key: string,
  players: IconRowPlayer[],
  preferred?: IconRowPlayer
): string | undefined => {
  for (const player of preferred ? [preferred, ...players] : players) {
    for (const skill of skillsForAbilityKey(player.skillBreakdown, key)) {
      if (typeof skill.actionType !== "object" || !("Normal" in skill.actionType)) continue;
      const action = skill.actionType.Normal;
      // Child first, then the player — the exact fall-through `getSkillName`
      // resolves the NAME with. Unknown-hash bodies have no map either way.
      for (const character of [skill.childCharacterType, player.characterType]) {
        if (typeof character !== "string" || character === "") continue;
        const url = abilityIconForAction(character, action);
        if (url) return url;
      }
    }
  }
  return undefined;
};
