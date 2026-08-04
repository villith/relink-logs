import type { ActionType, DamageTakenState, EnemyType } from "@/types";
import { humanizeNumber } from "@/utils";

import type { MetricDescriptor, MetricRow } from "./types";

const format = humanizeNumber;

/** Shown where the backend served no taken figures at all — a payload from a
 * binary older than the field. A zero would claim the player was never hit. */
const NOT_RECORDED = "—";

/** What a `takenAttack` row's label spells: the attacker and the attack, both
 * halves as their raw wire shapes so the view (which owns i18n) can name and
 * illustrate each. The label IS this JSON — `attackRows` writes it and the
 * view reads it through this parser, so the grammar has one author. */
export const takenAttackRowParts = (label: string): { enemyType: EnemyType; actionId: ActionType } | null => {
  try {
    const parts = JSON.parse(label) as { enemyType: EnemyType; actionId: ActionType };
    return parts && typeof parts === "object" && "enemyType" in parts && "actionId" in parts ? parts : null;
  } catch {
    return null;
  }
};

/** The i18n key (and params) naming one enemy attack. Enemy actions carry no
 * names in the game data, so a Normal attack is its raw id; a DoT tick has a
 * kind worth naming; anything else (link/SBA-flagged oddities) stays generic
 * rather than borrowing a player-skill name. */
export const takenAttackNameKey = (actionId: ActionType): { key: string; params?: Record<string, number> } => {
  if (typeof actionId === "object" && actionId !== null) {
    if ("Normal" in actionId) return { key: "ui.logs.taken-attack", params: { id: actionId.Normal } };
    if ("DamageOverTime" in actionId) return { key: "ui.logs.taken-dot" };
  }
  return { key: "ui.logs.taken-attack-other" };
};

/** Damage taken per second over the measured window — the rate column WCL
 * heads "DTPS". No window means no honest rate, and these figures come from
 * scrubbed reparses too, so the denominator must be the window's own length. */
const dtps = (amount: number, fightDurationMs?: number): string =>
  !fightDurationMs || fightDurationMs <= 0 ? NOT_RECORDED : format(amount / (fightDurationMs / 1000));

/** One row per (attacker class, attack), the taken table's drill-down shape.
 *
 * Deliberately NOT folded by attack across attackers, unlike Warcraft Logs:
 * GBFR action ids are per-enemy id spaces, so "action 1" from two enemies is
 * two unrelated moves and a merged row would fuse them under one meaningless
 * number. */
const attackRows = (breakdown: DamageTakenState[], fightDurationMs?: number): MetricRow[] => {
  const byAttack = new Map<string, { damage: number; hits: number }>();
  for (const row of breakdown) {
    const key = JSON.stringify({ enemyType: row.enemyType, actionId: row.actionId });
    const found = byAttack.get(key);
    if (found) {
      found.damage += row.totalDamage;
      found.hits += row.hits;
    } else byAttack.set(key, { damage: row.totalDamage, hits: row.hits });
  }

  return [...byAttack.entries()]
    .map(([key, { damage, hits }]) => ({
      key: `taken:${key}`,
      label: key,
      kind: "takenAttack" as const,
      value: damage,
      columns: [
        format(damage),
        String(hits),
        format(hits === 0 ? 0 : Math.round(damage / hits)),
        dtps(damage, fightDurationMs),
      ],
      // An enemy attack is not a pinnable ability — the pin model narrows by
      // the party's own actions — so these rows are leaves.
      pinOnClick: null,
      colorSlot: -1,
    }))
    .sort((a, b) => b.value - a.value);
};

/** Damage taken: players ranked by what they RECEIVED (amount + DTPS, the
 * Warcraft Logs shape), a pinned player (or the whole party) decomposed into
 * the attacks that dealt it. Logs recorded before the parser kept incoming
 * events carry no figures at all — those rows read "—" rather than claiming
 * nobody was ever hit. */
export const damageTaken: MetricDescriptor = {
  labelKey: "ui.logs.metric-damage-taken",

  columnKeys: (level) =>
    level === "players"
      ? ["ui.logs.column-damage-taken", "ui.logs.column-dtps"]
      : ["ui.logs.column-damage-taken", "ui.skill-columns.hits", "ui.skill-columns.average", "ui.logs.column-dtps"],

  labelKind: (level) => (level === "players" ? "player" : "takenAttack"),

  // Consumed only as the hover card's amount heading/format: the sections
  // themselves come from `takenCardSectionsFor`, not the skill-based builder,
  // so `valueOf`/`perTarget` never run on this tab.
  card: {
    amountKey: "ui.logs.column-damage-taken",
    valueOf: (skill) => skill.totalDamage,
    format,
    perTarget: false,
  },

  rows: ({ players, level, pins, fightDurationMs }): MetricRow[] => {
    if (level === "players") {
      return [...players]
        .sort((a, b) => (b.totalDamageTaken ?? 0) - (a.totalDamageTaken ?? 0))
        .map((p) => ({
          key: `player:${p.index}`,
          label: String(p.index),
          value: p.totalDamageTaken ?? 0,
          columns:
            p.totalDamageTaken === undefined
              ? [NOT_RECORDED, NOT_RECORDED]
              : [format(p.totalDamageTaken), dtps(p.totalDamageTaken, fightDurationMs)],
          pinOnClick: { source: p.index },
          colorSlot: p.partyIndex,
        }));
    }

    // A source pinned but missing from the scoped party has genuinely nothing
    // to show; NO pin widens to the whole party's attackers — same rule as
    // `damageDone`.
    const owner = pins.source === null ? null : players.find((p) => p.index === pins.source);
    if (pins.source !== null && !owner) return [];

    const breakdown = owner ? owner.damageTakenBreakdown ?? [] : players.flatMap((p) => p.damageTakenBreakdown ?? []);

    return attackRows(breakdown, fightDurationMs);
  },
};
