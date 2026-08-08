import type { ActionType, ComputedPlayerState, DamageTakenState, EnemyType } from "@/types";
import { humanizeNumber, ratePerSecond } from "@/utils";

import { skillsForAbilityKey } from "../abilitySkills";
import {
  enemyRowKey,
  playerRowKey,
  skillKeyPayload,
  takenAttackRowLabel,
  takenAttackRowParts,
  takenRowKey,
} from "../rowKey";
import { playersColumns } from "./damageDone";
import type { MetricDescriptor, MetricRow, RowLevel } from "./types";

const format = humanizeNumber;

/** Shown where the backend served no taken figures at all — a payload from a
 * binary older than the field. A zero would claim the player was never hit. */
const NOT_RECORDED = "—";

/** Re-exported from the grammar's own module, where the writing half lives
 * beside it — the view has always imported this from here. */
export { takenAttackRowParts };

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

/** The four-column drill-down shape every damage-taken row below the players
 * level fills (see `columnKeys`) — amount, hits, average hit, DTPS. Written
 * once because `attackRows` and `enemyReceivedRows` are two different folds
 * that both land on this same shape, and it has to stay one shape for both to
 * line up under one header. */
export const drilldownColumns = (damage: number, hits: number, fightDurationMs?: number): string[] => [
  format(damage),
  String(hits),
  format(hits === 0 ? 0 : Math.round(damage / hits)),
  ratePerSecond(damage, fightDurationMs),
];

/** One row per (attacker class, attack), the taken table's drill-down shape.
 *
 * Deliberately NOT folded by attack across attackers, unlike Warcraft Logs:
 * GBFR action ids are per-enemy id spaces, so "action 1" from two enemies is
 * two unrelated moves and a merged row would fuse them under one meaningless
 * number. */
const attackRows = (breakdown: DamageTakenState[], fightDurationMs?: number): MetricRow[] => {
  const byAttack = new Map<string, { damage: number; hits: number }>();
  for (const row of breakdown) {
    const key = takenAttackRowLabel(row.enemyType, row.actionId);
    const found = byAttack.get(key);
    if (found) {
      found.damage += row.totalDamage;
      found.hits += row.hits;
    } else byAttack.set(key, { damage: row.totalDamage, hits: row.hits });
  }

  return [...byAttack.entries()]
    .map(([key, { damage, hits }]) => ({
      key: takenRowKey(key),
      label: key,
      kind: "takenAttack" as const,
      value: damage,
      columns: drilldownColumns(damage, hits, fightDurationMs),
      // An enemy attack is not a pinnable ability — the pin model narrows by
      // the party's own actions — so these rows are leaves.
      pinOnClick: null,
      colorSlot: -1,
    }))
    .sort((a, b) => b.value - a.value);
};

/** Enemy types ranked by damage RECEIVED from the (scoped) party, folded from
 * every player's per-ability per-enemy dealt rows (`SkillState.targets`).
 * Recoverable by reparse from every log ever recorded, unlike the incoming
 * stream the friendly side reads, which was never captured before
 * 2026-08-04 — `targets` itself is still optional per skill (cached payloads
 * predate it), hence the `?? []` below.
 *
 * At the players level this answers the same amount+DTPS+share question as
 * the friendly side, so it takes the same three columns (share computed over
 * this fold's own total, not the friendly side's). Below it, `columnKeys`
 * switches to the four-column drill-down shape every other damage-taken row
 * fills (see `drilldownColumns`), and this one must too or it renders rows
 * that don't match a four-column header. Unlike `damageDone`'s enemy side,
 * nothing here needs blanking: `SkillTargetState` carries both damage and
 * hits honestly. */
const enemyReceivedRows = (players: ComputedPlayerState[], level: RowLevel, fightDurationMs?: number): MetricRow[] => {
  const byType = new Map<string, { enemyType: EnemyType; damage: number; hits: number }>();
  for (const player of players) {
    for (const skill of player.skillBreakdown) {
      for (const target of skill.targets ?? []) {
        const key = JSON.stringify(target.enemyType);
        const found = byType.get(key);
        if (found) {
          found.damage += target.totalDamage;
          found.hits += target.hits;
        } else byType.set(key, { enemyType: target.enemyType, damage: target.totalDamage, hits: target.hits });
      }
    }
  }

  const total = [...byType.values()].reduce((sum, { damage }) => sum + damage, 0);

  return [...byType.entries()]
    .map(([key, { enemyType, damage, hits }]) => ({
      key: enemyRowKey(enemyType),
      label: key,
      kind: "enemy" as const,
      value: damage,
      columns:
        level === "players"
          ? playersColumns(damage, total, fightDurationMs)
          : drilldownColumns(damage, hits, fightDurationMs),
      // The pin model has no enemy-type pin; the hover card decomposes instead.
      pinOnClick: null,
      colorSlot: -1,
    }))
    .sort((a, b) => b.value - a.value);
};

/** Damage taken: players ranked by what they RECEIVED (amount + DTPS + share
 * of the party total, the Damage Done shape), a pinned player (or the whole
 * party) decomposed into the attacks that dealt it. Logs recorded before the
 * parser kept incoming events carry no figures at all — those rows read "—"
 * rather than claiming nobody was ever hit. */
export const damageTaken: MetricDescriptor = {
  labelKey: "ui.logs.metric-damage-taken",
  supportsHostility: true,

  columnKeys: (level) =>
    level === "players"
      ? ["ui.logs.column-damage-taken", "ui.logs.column-dtps", "ui.logs.column-share"]
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

  rows: ({ players, level, pins, fightDurationMs, hostility }): MetricRow[] => {
    // The enemy side answers one question at every level — what each enemy
    // received from the (scoped) party — so it ignores the drill level
    // entirely except for which column shape that answer takes.
    if (hostility === "enemy") return enemyReceivedRows(players, level, fightDurationMs);

    if (level === "players") {
      // Share of the party total taken — the same last column Damage Done's
      // players level carries, closing the §6 inconsistency.
      const total = players.reduce((sum, p) => sum + (p.totalDamageTaken ?? 0), 0);
      return [...players]
        .sort((a, b) => (b.totalDamageTaken ?? 0) - (a.totalDamageTaken ?? 0))
        .map((p) => ({
          key: playerRowKey(p.index),
          label: String(p.index),
          value: p.totalDamageTaken ?? 0,
          columns:
            p.totalDamageTaken === undefined
              ? [NOT_RECORDED, NOT_RECORDED, NOT_RECORDED]
              : playersColumns(p.totalDamageTaken, total, fightDurationMs),
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

  // The table's in-place nesting (Package C). The friendly side's ability rows
  // are enemy ATTACKS; party-wide, each splits per VICTIM — this tab's source
  // dimension — out of every scoped player's `damageTakenBreakdown`, matched
  // by the same (attacker, attack) JSON the row key spells. The enemy side's
  // ability rows are the party's own abilities (the dealt stream), so they
  // split per dealing player. Either way a pinned source leaves one child,
  // which would only restate the parent — null instead.
  children: ({ row, players, level, pins, fightDurationMs, hostility }): MetricRow[] | null => {
    if (level !== "abilities" || pins.source !== null) return null;

    if (hostility === "enemy") {
      const key = skillKeyPayload(row.key);
      if (key === null) return null;
      return players
        .map((player) => ({ player, skills: skillsForAbilityKey(player.skillBreakdown, key) }))
        .filter(({ skills }) => skills.length > 0)
        .map(({ player, skills }): MetricRow => {
          const damage = skills.reduce((sum, skill) => sum + skill.totalDamage, 0);
          const hits = skills.reduce((sum, skill) => sum + skill.hits, 0);
          return {
            key: playerRowKey(player.index),
            label: String(player.index),
            kind: "player",
            value: damage,
            columns: drilldownColumns(damage, hits, fightDurationMs),
            // A leaf: the enemy side's pin universes belong to the enemy
            // role-mapping, and a player child must not pin into them.
            pinOnClick: null,
            colorSlot: player.partyIndex,
          };
        })
        .sort((a, b) => b.value - a.value);
    }

    if (!row.key.startsWith("taken:")) return null;
    const label = row.key.slice("taken:".length);
    return players
      .map((player) => ({
        player,
        entries: (player.damageTakenBreakdown ?? []).filter(
          (entry) => JSON.stringify({ enemyType: entry.enemyType, actionId: entry.actionId }) === label
        ),
      }))
      .filter(({ entries }) => entries.length > 0)
      .map(({ player, entries }): MetricRow => {
        const damage = entries.reduce((sum, entry) => sum + entry.totalDamage, 0);
        const hits = entries.reduce((sum, entry) => sum + entry.hits, 0);
        return {
          key: playerRowKey(player.index),
          label: String(player.index),
          kind: "player",
          value: damage,
          columns: drilldownColumns(damage, hits, fightDurationMs),
          // Clicking a victim child pins that victim — the machine keeps the
          // attack pin, so the next state is that victim's drill.
          pinOnClick: { source: player.index },
          colorSlot: player.partyIndex,
        };
      })
      .sort((a, b) => b.value - a.value);
  },
};
