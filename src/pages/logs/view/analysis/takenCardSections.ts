import type { ActionType, ComputedPlayerState, EnemyType } from "@/types";

import type { MetricRow } from "../metrics/types";

import type { CardSection } from "./HoverCard";

/** Name and art lookups the view injects, so this stays a pure function —
 * the same posture as `SectionLabels` in cardSections.ts. */
export type TakenSectionLabels = {
  /** One enemy attack, named with its attacker for context — enemy action ids
   * carry no names of their own. */
  attack: (enemyType: EnemyType, actionId: ActionType) => string;
  enemy: (type: EnemyType) => string;
  enemyIcon?: (type: EnemyType) => string | undefined;
};

/** The attacker section's colour: enemies are the same red the damage card's
 * target section paints them. */
const SOURCE_COLOR = "var(--mantine-color-red-6)";

/** The taken tab's hover card: a player row is explained by the attacks that
 * hit them and by the enemies those attacks came from — Warcraft Logs' two
 * sections. Drill rows carry no card at all: one row already fixes the
 * attacker, the attack AND the victim, so there is nothing left to decompose. */
export const takenCardSectionsFor = ({
  row,
  players,
  color,
  labels,
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The row's own colour, so the by-ability section matches its bar. */
  color: string;
  labels: TakenSectionLabels;
}): CardSection[] | null => {
  if (!row.key.startsWith("player:")) return null;
  const player = players.find((candidate) => `player:${candidate.index}` === row.key);
  const breakdown = player?.damageTakenBreakdown ?? [];
  if (breakdown.length === 0) return null;

  const byAttack = new Map<string, { label: string; value: number; icon?: string }>();
  const byEnemy = new Map<string, { label: string; value: number; icon?: string }>();
  for (const entry of breakdown) {
    // JSON keys, not String(): both halves are tagged unions and String()
    // would merge every one of them into "[object Object]".
    const attackKey = JSON.stringify({ enemyType: entry.enemyType, actionId: entry.actionId });
    const enemyKey = JSON.stringify(entry.enemyType);
    const attack = byAttack.get(attackKey);
    if (attack) attack.value += entry.totalDamage;
    else
      byAttack.set(attackKey, {
        label: labels.attack(entry.enemyType, entry.actionId),
        value: entry.totalDamage,
        icon: labels.enemyIcon?.(entry.enemyType),
      });
    const enemy = byEnemy.get(enemyKey);
    if (enemy) enemy.value += entry.totalDamage;
    else
      byEnemy.set(enemyKey, {
        label: labels.enemy(entry.enemyType),
        value: entry.totalDamage,
        icon: labels.enemyIcon?.(entry.enemyType),
      });
  }

  const entriesOf = (folded: Map<string, { label: string; value: number; icon?: string }>) =>
    [...folded.entries()]
      .map(([key, { label, value, icon }]) => ({ key, label, value, icon }))
      .sort((a, b) => b.value - a.value);

  return [
    { headingKey: "ui.logs.hover-by-ability", color, entries: entriesOf(byAttack) },
    { headingKey: "ui.logs.hover-by-source", color: SOURCE_COLOR, entries: entriesOf(byEnemy) },
  ];
};
