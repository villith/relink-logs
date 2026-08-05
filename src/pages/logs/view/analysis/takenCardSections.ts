import type { ActionType, ComputedPlayerState, EnemyType } from "@/types";

import { takenAttackRowParts } from "../metrics/damageTaken";
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

/** The taken tab's hover card for a PLAYER row: explained by the attacks that
 * hit them and by the enemies those attacks came from — Warcraft Logs' two
 * sections. Drilled attack rows have their own builder below. */
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

/** Who the injected victim lookups are: the party's own names and colours,
 * the same ones every by-source section injects. */
export type TakenVictimLabels = {
  source: (index: number) => string;
  sourceColor: (index: number) => string;
  sourceIcon?: (index: number) => string | undefined;
};

/** The taken tab's hover card for a DRILLED attack row (`taken:<json>`): one
 * enemy attack split across the victims who took it — the dimension the
 * grouping leaves free. Under a victim pin the split narrows to that victim
 * and holds one row at 100%, keeping the card's shape as pins change (the
 * same posture as the skills-level source section).
 *
 * No attacker-spawn section: `DamageTakenState` carries no segment and the
 * segmenter deliberately never assigns taken events one (see
 * `segment_targets_inner`), so a per-spawn split of the attacker is not
 * derivable — the row's own label already names the attacker TYPE. */
export const takenAbilityCardSectionsFor = ({
  row,
  players,
  source,
  color,
  labels,
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The pinned victim, narrowing the split the way the table rows are
   * narrowed — the scoped party's taken breakdowns are NOT pin-filtered by
   * the backend (taken events bypass the selection gates), so the card must
   * apply the pin itself or it would total more than the row it explains.
   * Under an active TARGET pin the same drift can also arise from the
   * opposite side — there the backend narrows the row to the pinned attacker
   * SPAWN's lifespan, which `damageTakenBreakdown` (no segments, no
   * timestamps) cannot mirror — so with same-type respawns the card can total
   * more than the row, the same type-level approximation this builder already
   * documents above. */
  source: number | null;
  color: string;
  labels: TakenVictimLabels;
}): CardSection[] | null => {
  if (!row.key.startsWith("taken:")) return null;
  // The label IS the JSON `takenAttackRowParts` reads — the grammar has one
  // author (`attackRows` / `groupRowsFor`'s enemyAttack case).
  const parts = takenAttackRowParts(row.label);
  if (parts === null) return null;
  const enemyKey = JSON.stringify(parts.enemyType);
  const actionKey = JSON.stringify(parts.actionId);

  const scoped = source === null ? players : players.filter((player) => player.index === source);
  const byVictim: { key: string; label: string; value: number; color: string; icon?: string }[] = [];
  for (const player of scoped) {
    let took = 0;
    // Optional because a log recorded before damage-taken capture (2026-08-04)
    // has no incoming events at all — no rows rather than zeroed ones.
    for (const entry of player.damageTakenBreakdown ?? []) {
      // JSON halves compared separately, not one re-stringified object:
      // property order must not decide equality.
      if (JSON.stringify(entry.enemyType) !== enemyKey || JSON.stringify(entry.actionId) !== actionKey) continue;
      took += entry.totalDamage;
    }
    if (took > 0) {
      byVictim.push({
        key: `victim:${player.index}`,
        label: labels.source(player.index),
        value: took,
        // Each victim in their OWN party colour.
        color: labels.sourceColor(player.index),
        icon: labels.sourceIcon?.(player.index),
      });
    }
  }
  // Nobody recorded taking it — no card, rather than an empty one.
  if (byVictim.length === 0) return null;

  return [
    {
      headingKey: "ui.logs.hover-by-source",
      color,
      entries: byVictim.sort((a, b) => b.value - a.value),
    },
  ];
};
