import type { ComputedPlayerState, EnemyType, SkillState } from "@/types";
import { humanizeNumber, share } from "@/utils";

import { groupSkillsForRows, mergeSkillsByAction, type AbilitySkills } from "../abilitySkills";
import type { RowLevel } from "../deriveRows";
import type { MetricDescriptor, MetricRow } from "./types";

const format = humanizeNumber;

/** Shown where a figure was never recorded — logs saved before `minDamage` and
 * `maxDamage` existed carry null, and the per-enemy breakdown never carried
 * them at all. A zero would claim a hit landed for nothing. */
const NOT_RECORDED = "—";

/** The smallest or largest single hit across an ability's skills, formatted.
 *
 * Extremes are taken across contributors rather than from one of them: a player
 * and their summon are separate breakdown rows under one ability. */
const extreme = (values: (number | null)[], pick: (values: number[]) => number): string => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? NOT_RECORDED : format(pick(known));
};

/** The numeric columns every damage row below the players level fills, in
 * header order. Written once because the three shapes of drill-down row have to
 * line up under ONE header — see `columnKeys`. */
const damageColumns = (damage: number, hits: number, min: string, max: string, total: number): string[] => [
  format(damage),
  String(hits),
  min,
  max,
  format(hits === 0 ? 0 : Math.round(damage / hits)),
  share(damage, total),
];

/** Rows for a set of ability (or member-skill) groups. */
const abilityRows = (groups: AbilitySkills[], total: number, colorSlot: number, pinnable: boolean): MetricRow[] =>
  groups
    .map(({ key, skills }) => {
      const damage = skills.reduce((sum, skill) => sum + skill.totalDamage, 0);
      const hits = skills.reduce((sum, skill) => sum + skill.hits, 0);
      return {
        key: `skill:${key}`,
        label: key,
        value: damage,
        columns: damageColumns(
          damage,
          hits,
          extreme(
            skills.map((skill) => skill.minDamage),
            (values) => Math.min(...values)
          ),
          extreme(
            skills.map((skill) => skill.maxDamage),
            (values) => Math.max(...values)
          ),
          total
        ),
        pinOnClick: pinnable ? { ability: key } : null,
        colorSlot,
      };
    })
    .sort((a, b) => b.value - a.value);

/** The `EnemyType` an `enemy` row's label spells, or null for anything that is
 * not one.
 *
 * The label IS the type's JSON — `enemyRows` writes it and the view reads it,
 * so the grammar has one author. Tolerant of a malformed label for the same
 * reason `statusLabelFor` is of a stale pin: `translateEnemyType` and
 * `enemyIconUrl` both answer null with "unknown", which beats throwing inside
 * a row renderer. */
export const parseEnemyRow = (label: string): EnemyType | null => {
  try {
    return JSON.parse(label) as EnemyType;
  } catch {
    return null;
  }
};

/** What the pinned ability dealt to each enemy TYPE.
 *
 * `SkillState.targets` is optional because cached payloads predate it, and it
 * carries no per-enemy extremes — those columns are honestly blank rather than
 * guessed at from the ability's own. Same-type spawns are already merged by the
 * parser, so these rows name a type and pin nothing: the target pin selects a
 * SPAWN, and a type cannot choose between two of them. */
const enemyRows = (skills: SkillState[], total: number): MetricRow[] => {
  const byType = new Map<string, { damage: number; hits: number }>();
  for (const skill of skills) {
    for (const target of skill.targets ?? []) {
      // JSON, not String(): EnemyType is `string | { Unknown: number }`, and
      // String() renders every Unknown variant as "[object Object]", merging
      // every unidentified spawn into one row.
      const key = JSON.stringify(target.enemyType);
      const found = byType.get(key);
      if (found) {
        found.damage += target.totalDamage;
        found.hits += target.hits;
      } else byType.set(key, { damage: target.totalDamage, hits: target.hits });
    }
  }

  return [...byType.entries()]
    .map(([key, { damage, hits }]) => ({
      key: `enemy:${key}`,
      label: key,
      kind: "enemy" as const,
      value: damage,
      columns: damageColumns(damage, hits, NOT_RECORDED, NOT_RECORDED, total),
      pinOnClick: null,
      colorSlot: -1,
    }))
    .sort((a, b) => b.value - a.value);
};

/** Damage per second over the measured window, or "—" without one (same rule
 * as damageTaken's DTPS — these figures come from scrubbed reparses too). */
const rateOver = (amount: number, fightDurationMs?: number): string =>
  !fightDurationMs || fightDurationMs <= 0 ? NOT_RECORDED : format(amount / (fightDurationMs / 1000));

/** Enemy types ranked by what they dealt TO the party, folded from the
 * per-victim incoming breakdown. Empty on logs recorded before damage-taken
 * capture (2026-08-04) — those recorded no incoming events at all, and the
 * table's empty state says so.
 *
 * At the players level this answers one question with three columns (amount,
 * rate, share), same as the friendly side. Below it, every OTHER damageDone
 * row shape fills the full six-column set (see `damageColumns`), and this one
 * must too or it renders three cells under a six-column header. Min stays
 * blank there because `DamageTakenState` — unlike `SkillState` — never
 * recorded a minimum; max is the largest single hit any breakdown row for
 * that type carried. */
const enemyDealtRows = (players: ComputedPlayerState[], level: RowLevel, fightDurationMs?: number): MetricRow[] => {
  const byType = new Map<string, { damage: number; hits: number; maxDamage: number | null }>();
  for (const player of players) {
    for (const row of player.damageTakenBreakdown ?? []) {
      const key = JSON.stringify(row.enemyType);
      const found = byType.get(key);
      if (found) {
        found.damage += row.totalDamage;
        found.hits += row.hits;
        found.maxDamage = found.maxDamage === null ? row.maxDamage : Math.max(found.maxDamage, row.maxDamage);
      } else byType.set(key, { damage: row.totalDamage, hits: row.hits, maxDamage: row.maxDamage });
    }
  }
  const total = [...byType.values()].reduce((sum, { damage }) => sum + damage, 0);

  return [...byType.entries()]
    .map(([key, { damage, hits, maxDamage }]) => ({
      key: `enemy:${key}`,
      label: key,
      kind: "enemy" as const,
      value: damage,
      columns:
        level === "players"
          ? [format(damage), rateOver(damage, fightDurationMs), share(damage, total)]
          : damageColumns(damage, hits, NOT_RECORDED, maxDamage === null ? NOT_RECORDED : format(maxDamage), total),
      // The pin model has no enemy-type pin; the hover card decomposes instead.
      pinOnClick: null,
      colorSlot: -1,
    }))
    .sort((a, b) => b.value - a.value);
};

export const damageDone: MetricDescriptor = {
  labelKey: "ui.logs.metric-damage-done",
  supportsHostility: true,

  // Players are ranked by damage and rate; below that a rate over one skill
  // means little, so the second column becomes how often it landed and the
  // spread of those hits follows. Share is last in both cases, of whatever the
  // level's total is.
  //
  // One header for all three shapes of drill-down row: the level cannot say in
  // advance whether it will decompose into member skills, enemies or players,
  // and the columns line up under it either way — a shape with no extremes to
  // report leaves those two cells blank rather than moving the ones after them.
  columnKeys: (level) =>
    level === "players"
      ? ["ui.meter-columns.damage", "ui.meter-columns.dps", "ui.logs.column-share"]
      : [
          "ui.skill-columns.total",
          "ui.skill-columns.hits",
          "ui.skill-columns.min",
          "ui.skill-columns.max",
          "ui.skill-columns.average",
          "ui.logs.column-share",
        ],

  labelKind: (level) => (level === "players" ? "player" : "ability"),

  // The only metric the parser records per enemy (`SkillTargetState`), so the
  // only one whose card can break a row down by target.
  card: {
    amountKey: "ui.meter-columns.damage",
    valueOf: (skill) => skill.totalDamage,
    format,
    perTarget: true,
  },

  rows: ({ players, level, pins, fightDurationMs, hostility }): MetricRow[] => {
    // The enemy side answers one question at every level — what each enemy
    // dealt to the (scoped) party — so it ignores the drill level entirely
    // except for which column shape that answer takes.
    if (hostility === "enemy") return enemyDealtRows(players, level, fightDurationMs);

    if (level === "players") {
      const total = players.reduce((sum, p) => sum + p.totalDamage, 0);
      return [...players]
        .sort((a, b) => b.totalDamage - a.totalDamage)
        .map((p) => ({
          key: `player:${p.index}`,
          label: String(p.index),
          value: p.totalDamage,
          columns: [format(p.totalDamage), format(p.dps), share(p.totalDamage, total)],
          pinOnClick: { source: p.index },
          colorSlot: p.partyIndex,
        }));
    }

    // A source pinned but missing from the scoped party has genuinely nothing
    // to show. NO source pinned is a different case: the ability sets the level
    // and clearing the friendly only widens the scope to the whole party, so the
    // rows stay the same rows, summed across everyone.
    const owner = pins.source === null ? null : players.find((p) => p.index === pins.source);
    if (pins.source !== null && !owner) return [];

    const breakdown = owner ? owner.skillBreakdown : players.flatMap((p) => p.skillBreakdown);
    const total = owner ? owner.totalDamage : players.reduce((sum, p) => sum + p.totalDamage, 0);
    // A row summed across players belongs to no one party slot; -1 is the
    // table's "no colour" and renders in its neutral ink.
    const colorSlot = owner ? owner.partyIndex : -1;

    // The abilities level condenses into skill-group rows — see `abilityRowKey`.
    // One row is what the user pins, so a row must be one thing: a group where
    // the app groups, and otherwise one ability however many breakdown rows fed
    // it.
    if (level === "abilities") return abilityRows(groupSkillsForRows(breakdown), total, colorSlot, true);

    // The skills level is the same breakdown NOT condensed: the scoped fetch has
    // already narrowed the party to the pinned row's member actions, so folding
    // them again would redraw the row just clicked.
    const members = mergeSkillsByAction(breakdown);
    // More than one action behind the pinned row means it was a GROUP, and the
    // members are what it was made of.
    if (members.length > 1) return abilityRows(members, total, colorSlot, false);

    // One action behind the pinned row: restating it as a single row says
    // nothing the row above it did not. With a friendly pinned, Warcraft Logs
    // turns to the dimension the pins have left free and lists what the ability
    // HIT — so do that.
    //
    // Only with an owner. Summed across the party the row is already an answer
    // to a different question ("what did this ability do for everyone"), and
    // the per-enemy breakdown behind it cannot say who dealt which part of it.
    //
    // A log saved before `SkillState.targets` existed has no enemies to list;
    // the single row is still the honest floor.
    if (owner) {
      const enemies = enemyRows(breakdown, total);
      if (enemies.length > 0) return enemies;
    }
    return abilityRows(members, total, colorSlot, false);
  },
};
