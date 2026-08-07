import type { ActionType, ComputedPlayerState, EnemyType } from "@/types";

import { parseEnemyRow } from "../metrics/damageDone";
import type { MetricRow } from "../metrics/types";

import type { CardSection } from "./HoverCard";
import { foldPartyDealt, sortedEntries } from "./cardFold";

/** Name/colour lookups the view injects, so these stay pure functions — the
 * same posture as `SectionLabels` in cardSections.ts.
 *
 * Deliberately the UNION of what both enemy-side cards need rather than one
 * type each: the view holds a single labels object for both tabs, and two
 * near-identical shapes would let one tab's names drift from the other's. */
export type HostilityCardLabels = {
  /** One enemy attack, named with its attacker for context — enemy action ids
   * carry no names of their own. Same lookup the taken card uses. */
  attack: (enemyType: EnemyType, actionId: ActionType) => string;
  /** `owner` is the player whose breakdown the key is being named for. Action
   * ids collide across characters (120 is Eustace's "Grade 1 Shot" AND Id's
   * "Combo Finisher (Dragonform)"), so an ability folded out of one player's
   * table must be named against THAT player — the by-ability section below
   * spans the whole party, so it passes an owner for every entry. */
  ability: (key: string, owner?: ComputedPlayerState) => string;
  /** A player's display name, honouring streamer mode and the label template. */
  source: (index: number) => string;
  /** That player's own party colour, so a player row matches their bar. */
  sourceColor: (index: number) => string;
  /** The entities' art, optional so tests stay text-only. */
  sourceIcon?: (index: number) => string | undefined;
  abilityIcon?: (key: string, owner?: ComputedPlayerState) => string | undefined;
};

/** Players painted as the card's "other side": the same red the damage card's
 * target section uses, so a section about the OPPOSING side is the same colour
 * whichever tab it is on. */
const TARGET_COLOR = "var(--mantine-color-red-6)";

/** The enemy type an `enemy:`-keyed row names, or null for anything that is not
 * one. The label IS the type's JSON — the same grammar `damageDone`'s and
 * `damageTaken`'s enemy rows write, parsed by its one author. */
const enemyOfRow = (row: MetricRow): EnemyType | null =>
  row.key.startsWith("enemy:") ? parseEnemyRow(row.label) : null;

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
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The row's own colour, so the card matches the bar it came from. */
  color: string;
  labels: HostilityCardLabels;
}): CardSection[] | null => {
  const enemy = enemyOfRow(row);
  if (enemy === null) return null;
  const enemyKey = JSON.stringify(enemy);

  // Every spawn of the type, by design: an enemy ROW merges its spawns, so its
  // card must account for all of them.
  const { bySource, byAbility } = foldPartyDealt(
    players,
    (target) => JSON.stringify(target.enemyType) === enemyKey,
    labels
  );
  // Nobody dealt to this enemy — no card, rather than an empty one.
  if (bySource.length === 0) return null;

  return [
    { headingKey: "ui.logs.hover-by-source", color, entries: sortedEntries(bySource) },
    { headingKey: "ui.logs.hover-by-ability", color, entries: sortedEntries(byAbility) },
  ];
};
