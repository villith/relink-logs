import type { CharacterType, ComputedPlayerState, SkillRow } from "@/types";

import { abilityKey, parseAbilityKey } from "../abilityKey";
import { abilityRowKey, abilityRowName, groupOfPin } from "../abilitySkills";

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
  skillName: (characterType: CharacterType, skill: SkillRow) => string
): string => {
  // A condensed group row is named through `{ Group }`; anything else is named
  // through the action the key parses to. The raw key survives only when it is
  // neither — a stale or hand-edited URL, where showing it back is the answer.
  const group = groupOfPin(key);
  const action = group === null ? parseAbilityKey(key) : { Group: group };
  if (action === null) return key;

  // A group pin matches on the ROW key; a raw pin matches on the action alone,
  // deliberately — a key from a backend that sent no child character is raw even
  // where that player's own skill groups, and it must still find its owner.
  const owns = (entry: SkillRow) =>
    group === null ? abilityKey(entry.actionType) === key : abilityRowKey(entry) === key;

  // Named as the row the key names: through `{ Group }` for a group pin (shared
  // with the drill-down legend, so a band and this label cannot disagree), and
  // as the skill itself for a raw one.
  const name = (characterType: CharacterType, skill: SkillRow) =>
    group === null ? skillName(characterType, skill) : abilityRowName(characterType, skill, skillName);

  for (const player of players) {
    const skill = player.skillBreakdown.find(owns);
    if (skill) return name(player.characterType, skill);
  }

  // Nobody used it. No character to name it against and no child class to
  // resolve a summon body from, so the default chain answers — for a group,
  // through its own `skills.default.skill-groups.<group>` name.
  return skillName("", { actionType: action, childCharacterType: "" });
};

