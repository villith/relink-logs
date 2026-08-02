import type { CharacterType, ComputedPlayerState, SkillState } from "@/types";

import { abilityKey, parseAbilityKey } from "../abilityKey";

/** The party fields naming needs — the whole `ComputedPlayerState` is accepted,
 * this only names the parts that are read. */
export type AbilityLabelPlayer = Pick<ComputedPlayerState, "characterType" | "skillBreakdown">;

/** Display name for one `abilityKey`.
 *
 * Skill names are per character, so an ability is named against the first player
 * in `players` who used it. **Pass the IDENTITY party, not the scoped one.** The
 * scoped party holds only the pinned player while the ability options span the
 * whole fight, so searching it left every other player's abilities unnamed —
 * and the fallback then showed the user `abilityKey`'s wire form, "Normal:1000".
 *
 * An action nobody in the party used is still named, against no character: that
 * runs `getSkillName`'s own chain down to `skills.default.<id>` and finally
 * `skills.default.unknown-skill`, which reads as an unknown skill rather than as
 * the wire format. Actions in the global namespace (ids >= 99999) are not
 * character skills at all and land there by design.
 *
 * The raw key survives only when it does not parse — a stale or hand-edited URL,
 * where showing it back is what tells the user what is wrong.
 *
 * `skillName` is injected rather than imported so this stays pure; callers pass
 * `getSkillName` and re-derive on a language change. */
export const abilityLabelFor = (
  key: string,
  players: AbilityLabelPlayer[],
  skillName: (characterType: CharacterType, skill: SkillState) => string
): string => {
  const action = parseAbilityKey(key);
  if (!action) return key;

  for (const player of players) {
    const skill = player.skillBreakdown.find((entry) => abilityKey(entry.actionType) === key);
    if (skill) return skillName(player.characterType, skill);
  }

  // No owner, so no character to name it against and no child class to resolve a
  // summon body from — both lookups miss and the default chain answers.
  return skillName("", { actionType: action, childCharacterType: "" } as SkillState);
};
