import type { ComputedPlayerState, SkillTargetState } from "@/types";

import { abilityKey } from "../abilityKey";

/** Section entries rank by size, largest first — a hover card is read top-down
 * and the biggest contributor is the answer most people came for. */
export const sortedEntries = <T extends { value: number }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => b.value - a.value);

/** The name/colour lookups the party-dealt fold needs. Both card modules'
 * label types (`SectionLabels`, `HostilityCardLabels`) satisfy this — it is
 * deliberately the intersection of the two rather than either one, so neither
 * has to know about the other. */
export type DealtFoldLabels = {
  /** `owner` is the player whose breakdown the key is being named for. Action
   * ids collide across characters (120 is Eustace's "Grade 1 Shot" AND Id's
   * "Combo Finisher (Dragonform)"), so an ability folded out of one player's
   * table must be named against THAT player. */
  ability: (key: string, owner?: ComputedPlayerState) => string;
  abilityIcon?: (key: string, owner?: ComputedPlayerState) => string | undefined;
  /** A player's display name, honouring streamer mode and the label template. */
  source: (index: number) => string;
  /** That player's own party colour, so a source row matches their bar. */
  sourceColor: (index: number) => string;
  sourceIcon?: (index: number) => string | undefined;
};

export type SourceEntry = { key: string; label: string; value: number; color: string; icon?: string };
export type AbilityEntry = { key: string; label: string; value: number; icon?: string };

/** The party's damage to one enemy, split two ways at once: across who dealt
 * it and across what they used.
 *
 * Both enemy-facing hover cards are this fold — the friendly side's target
 * SPAWN card and the enemy side's received card. They differ only in which
 * target entries count, which is `matches`, and in the order they present the
 * two sections, which is left to the callers. The two sections answer different
 * questions about the SAME total, so both sum to the row's figure; folding them
 * in one pass is what keeps that true.
 *
 * `targets` is optional because cached payloads predate it; an absent list
 * means the breakdown is unavailable, not that nothing was hit.
 *
 * Abilities are keyed by the raw action and named against their OWN player: the
 * parser emits one `SkillState` per (action, child character), so this also
 * merges a player and their summon back into the one ability.
 */
export const foldPartyDealt = (
  players: ComputedPlayerState[],
  matches: (target: SkillTargetState) => boolean,
  labels: DealtFoldLabels
): { bySource: SourceEntry[]; byAbility: AbilityEntry[] } => {
  const bySource: SourceEntry[] = [];
  const byAbility = new Map<string, { label: string; value: number; icon?: string }>();

  for (const player of players) {
    let dealt = 0;
    for (const skill of player.skillBreakdown) {
      let skillDealt = 0;
      for (const target of skill.targets ?? []) {
        if (matches(target)) skillDealt += target.totalDamage;
      }
      if (skillDealt === 0) continue;
      dealt += skillDealt;

      const key = abilityKey(skill.actionType);
      const ability = byAbility.get(key);
      if (ability) ability.value += skillDealt;
      else
        byAbility.set(key, {
          label: labels.ability(key, player),
          value: skillDealt,
          icon: labels.abilityIcon?.(key, player),
        });
    }
    if (dealt > 0) {
      bySource.push({
        key: `source:${player.index}`,
        label: labels.source(player.index),
        value: dealt,
        // Each player in their OWN party colour: one colour across the section
        // would lose the only thing it is for.
        color: labels.sourceColor(player.index),
        icon: labels.sourceIcon?.(player.index),
      });
    }
  }

  return { bySource, byAbility: [...byAbility.entries()].map(([key, entry]) => ({ key, ...entry })) };
};
