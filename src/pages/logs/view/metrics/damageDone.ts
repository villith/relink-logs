import { humanizeNumber, share } from "@/utils";

import { groupSkillsForRows, mergeSkillsByAction } from "../abilitySkills";
import type { MetricDescriptor, MetricRow } from "./types";

const format = humanizeNumber;

/** Shown where a figure was never recorded — logs saved before `minDamage` and
 * `maxDamage` existed carry null. A zero would claim a hit landed for nothing. */
const NOT_RECORDED = "—";

/** The smallest or largest single hit across an ability's skills, formatted.
 *
 * Extremes are taken across contributors rather than from one of them: a player
 * and their summon are separate breakdown rows under one ability. */
const extreme = (values: (number | null)[], pick: (values: number[]) => number): string => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? NOT_RECORDED : format(pick(known));
};

export const damageDone: MetricDescriptor = {
  labelKey: "ui.logs.metric-damage-done",

  // Players are ranked by damage and rate; below that a rate over one skill
  // means little, so the second column becomes how often it landed and the
  // spread of those hits follows. Share is last in both cases, of whatever the
  // level's total is.
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

  rows: ({ players, level, pins }): MetricRow[] => {
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
    // it. The skills level below it is the same breakdown NOT condensed: the
    // scoped fetch has already narrowed the party to the pinned group's member
    // actions, so folding them again would redraw the row just clicked.
    const fold = level === "abilities" ? groupSkillsForRows : mergeSkillsByAction;

    return fold(breakdown)
      .map(({ key, skills }) => {
        const damage = skills.reduce((sum, skill) => sum + skill.totalDamage, 0);
        const hits = skills.reduce((sum, skill) => sum + skill.hits, 0);
        return {
          key: `skill:${key}`,
          label: key,
          value: damage,
          columns: [
            format(damage),
            String(hits),
            extreme(
              skills.map((skill) => skill.minDamage),
              (values) => Math.min(...values)
            ),
            extreme(
              skills.map((skill) => skill.maxDamage),
              (values) => Math.max(...values)
            ),
            format(hits === 0 ? 0 : Math.round(damage / hits)),
            share(damage, total),
          ],
          // Display only at the skills level: a member skill has nothing below
          // it to descend into.
          pinOnClick: level === "abilities" ? { ability: key } : null,
          colorSlot,
        };
      })
      .sort((a, b) => b.value - a.value);
  },
};
