import type { ComputedPlayerState, SkillTargetState } from "@/types";
import { isSupplementaryAction } from "@/utils";

import { abilityKey } from "../abilityKey";
import type { RowKeying } from "../abilitySkills";
import { playerRowKey } from "../rowKey";

import type { CardLabels } from "./cardLabels";

/** The card's "other side" heading colour — the damage card's target section
 * and the enemy tabs' by-target section. One literal, because a section about
 * the OPPOSING side must read the same colour whichever card it is on. */
export const TARGET_COLOR = "var(--mantine-color-red-6)";

/** Section entries rank by size, largest first — a hover card is read top-down
 * and the biggest contributor is the answer most people came for. */
export const sortedEntries = <T extends { value: number }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => b.value - a.value);

/** What the party-dealt fold needs — the intersection of what both card modules
 * hold, so neither has to know about the other. Both their label types are
 * `Pick`s of the same declaration (`cardLabels.ts`), so both satisfy this by
 * construction rather than by two shapes happening to line up. */
export type DealtFoldLabels = Pick<CardLabels, "ability" | "abilityIcon" | "source" | "sourceColor" | "sourceIcon">;

export type SourceEntry = {
  key: string;
  label: string;
  value: number;
  subValue?: number;
  color: string;
  icon?: string;
};
export type AbilityEntry = { key: string; label: string; value: number; subValue?: number; icon?: string };

/** The echo half as a `BreakdownEntry` fragment — `splitSupplementary`'s
 * `mixed` rule at damage grain, since this fold sums per-target shares rather
 * than whole breakdown rows: an entry holding BOTH halves has a split to draw,
 * one that is echo all the way across is already described by its label.
 *
 * Gated on the toggle as well, unlike the folds that split whole breakdown
 * rows. Those are mixed only BECAUSE a collapse put both halves in one bucket;
 * this one sums a spawn's damage per player, which mixes the two whether or
 * not anything was collapsed — and a bar that splits with the toggle off is
 * the toggle failing to be inert. */
const splitOf = (direct: number, echo: number, keying?: RowKeying): { subValue?: number } =>
  keying?.collapseSupplementary === true && direct > 0 && echo > 0 ? { subValue: echo } : {};

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
 *
 * With the collapse on, an echo joins the ACTION that caused it rather than
 * standing as an entry of its own — the card explains a row of a table where
 * echoes already ride their cause, and an entry the table has no row for would
 * be explaining a different fight. Deliberately the raw action and not the
 * whole row key: this fold has always listed raw actions rather than condensed
 * skill groups, and the collapse is not the place to change that.
 */
export const foldPartyDealt = (
  players: ComputedPlayerState[],
  matches: (target: SkillTargetState) => boolean,
  labels: DealtFoldLabels,
  keying?: RowKeying
): { bySource: SourceEntry[]; byAbility: AbilityEntry[] } => {
  const bySource: SourceEntry[] = [];
  const byAbility = new Map<string, { label: string; value: number; echo: number; direct: number; icon?: string }>();

  for (const player of players) {
    let dealt = 0;
    let playerEcho = 0;
    let playerDirect = 0;
    for (const skill of player.skillBreakdown) {
      let skillDealt = 0;
      for (const target of skill.targets ?? []) {
        if (matches(target)) skillDealt += target.totalDamage;
      }
      if (skillDealt === 0) continue;
      dealt += skillDealt;

      const echo = isSupplementaryAction(skill.actionType);
      if (echo) playerEcho += skillDealt;
      else playerDirect += skillDealt;
      // Unresolvable (or uncollapsed), the echo stays its own entry — which is
      // also its own row in the table, so nothing lands where it does not go.
      const cause = echo
        ? keying?.causeAction((skill.actionType as { SupplementaryDamage: number }).SupplementaryDamage) ?? null
        : null;
      const key = abilityKey(cause ?? skill.actionType);
      const ability = byAbility.get(key);
      if (ability) {
        ability.value += skillDealt;
        if (echo) ability.echo += skillDealt;
        else ability.direct += skillDealt;
      } else
        byAbility.set(key, {
          label: labels.ability(key, player),
          value: skillDealt,
          echo: echo ? skillDealt : 0,
          direct: echo ? 0 : skillDealt,
          icon: labels.abilityIcon?.(key, player),
        });
    }
    if (dealt > 0) {
      bySource.push({
        key: playerRowKey(player.index),
        label: labels.source(player.index),
        value: dealt,
        ...splitOf(playerDirect, playerEcho, keying),
        // Each player in their OWN party colour: one colour across the section
        // would lose the only thing it is for.
        color: labels.sourceColor(player.index),
        icon: labels.sourceIcon?.(player.index),
      });
    }
  }

  return {
    bySource,
    byAbility: [...byAbility.entries()].map(([key, { label, value, direct, echo, icon }]) => ({
      key,
      label,
      value,
      ...splitOf(direct, echo, keying),
      ...(icon === undefined ? {} : { icon }),
    })),
  };
};
