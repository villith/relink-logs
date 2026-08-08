import type { ComputedPlayerState, EnemyType } from "@/types";

import type { RowKeying } from "../abilitySkills";
import type { MetricRow } from "../metrics/types";
import { parseEnemyRow, rowRefOf } from "../rowKey";

import type { CardSection } from "./HoverCard";
import { TARGET_COLOR, foldPartyDealt, sortedEntries } from "./cardFold";
import type { CardLabels } from "./cardLabels";

/** What the enemy-side cards need. Deliberately the UNION of what BOTH of them
 * need rather than one type each: the view holds a single labels object for the
 * two tabs, and two near-identical shapes would let one tab's names drift from
 * the other's. */
export type HostilityCardLabels = Pick<
  CardLabels,
  "attack" | "ability" | "source" | "sourceColor" | "sourceIcon" | "abilityIcon"
>;

/** The enemy type an enemy-keyed row names, or null for anything that is not
 * one — read through the row-key grammar's one author (`rowKey.ts`), so this
 * cannot come to disagree with the folds that write those rows. */
const enemyOfRow = (row: MetricRow): EnemyType | null =>
  rowRefOf(row.key)?.kind === "enemy" ? parseEnemyRow(row.label) : null;

/** Damage Done, enemy side: one ATTACKER explained by the attacks it landed and
 * by the party members it landed them on — both folded out of the party's own
 * incoming-damage breakdown, which is the only place this direction is
 * recorded.
 *
 * The attacks carry no icon: every one of them belongs to the row's own enemy,
 * whose portrait the row above the card already shows, so a column of identical
 * portraits would say nothing. */
export const enemyDealtCardSectionsFor = ({
  row,
  players,
  color,
  labels,
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The row's own colour, so the by-ability section matches its bar. */
  color: string;
  labels: HostilityCardLabels;
}): CardSection[] | null => {
  const enemy = enemyOfRow(row);
  if (enemy === null) return null;
  // JSON, not String(): EnemyType is `string | { Unknown: number }`, and
  // String() renders every Unknown variant as "[object Object]" — every
  // unidentified spawn would match every enemy row.
  const enemyKey = JSON.stringify(enemy);

  const byAttack = new Map<string, { label: string; value: number }>();
  const byVictim: { key: string; label: string; value: number; color: string; icon?: string }[] = [];
  for (const player of players) {
    let victimTotal = 0;
    // Optional because a log recorded before damage-taken capture (2026-08-04)
    // has no incoming events at all — no rows rather than zeroed ones.
    for (const entry of player.damageTakenBreakdown ?? []) {
      if (JSON.stringify(entry.enemyType) !== enemyKey) continue;
      victimTotal += entry.totalDamage;
      // Folded across the party: one attack that hit three players is one row
      // in the by-ability section, and the by-target section beneath it is
      // where the split by victim lives.
      const attackKey = JSON.stringify(entry.actionId);
      const attack = byAttack.get(attackKey);
      if (attack) attack.value += entry.totalDamage;
      else byAttack.set(attackKey, { label: labels.attack(entry.enemyType, entry.actionId), value: entry.totalDamage });
    }
    if (victimTotal > 0) {
      byVictim.push({
        key: `victim:${player.index}`,
        label: labels.source(player.index),
        value: victimTotal,
        // Each victim in their OWN party colour: one colour across the section
        // would lose the only thing it is for.
        color: labels.sourceColor(player.index),
        icon: labels.sourceIcon?.(player.index),
      });
    }
  }
  // Nothing recorded against this enemy — no card, rather than an empty one.
  if (byAttack.size === 0) return null;

  return [
    {
      headingKey: "ui.logs.hover-by-ability",
      color,
      entries: sortedEntries([...byAttack.entries()].map(([key, entry]) => ({ key, ...entry }))),
    },
    { headingKey: "ui.logs.hover-by-target", color: TARGET_COLOR, entries: sortedEntries(byVictim) },
  ];
};

/** Damage Taken, enemy side: one VICTIM explained by who dealt to it and with
 * what — both folded out of the party's per-ability per-enemy dealt rows
 * (`SkillState.targets`), which every log ever recorded carries.
 *
 * The two sections answer different questions about the same total, so they
 * both sum to the row's figure: by source splits it across the party, by
 * ability across what the party used. */
export const enemyReceivedCardSectionsFor = ({
  row,
  players,
  color,
  labels,
  keying,
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The row's own colour, so the card matches the bar it came from. */
  color: string;
  labels: HostilityCardLabels;
  /** The view's row keying — this card's by-ability section lists what the
   * party used, so an echo has to ride its cause here as it does in the table. */
  keying?: RowKeying;
}): CardSection[] | null => {
  const enemy = enemyOfRow(row);
  if (enemy === null) return null;
  const enemyKey = JSON.stringify(enemy);

  // Every spawn of the type, by design: an enemy ROW merges its spawns, so its
  // card must account for all of them.
  const { bySource, byAbility } = foldPartyDealt(
    players,
    (target) => JSON.stringify(target.enemyType) === enemyKey,
    labels,
    keying
  );
  // Nobody dealt to this enemy — no card, rather than an empty one.
  if (bySource.length === 0) return null;

  return [
    { headingKey: "ui.logs.hover-by-source", color, entries: sortedEntries(bySource) },
    { headingKey: "ui.logs.hover-by-ability", color, entries: sortedEntries(byAbility) },
  ];
};
