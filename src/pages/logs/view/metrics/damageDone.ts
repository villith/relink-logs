import { humanizeNumbers } from "@/utils";

import { groupSkillsByAbility } from "../abilitySkills";
import type { MetricDescriptor, MetricRow } from "./types";

const format = (value: number): string => {
  const [n, suffix] = humanizeNumbers(value);
  return `${n}${suffix}`;
};

/** Share of `total`, or "0.0%" when there is no total to divide by. */
const share = (value: number, total: number): string => (total === 0 ? "0.0%" : `${((value / total) * 100).toFixed(1)}%`);

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

    const owner = players.find((p) => p.index === pins.source);
    if (!owner) return [];

    // Grouped, not mapped 1:1: a player and their summon sharing an action id
    // are two breakdown rows under one ability, and one row per ability is what
    // the user pinned.
    return groupSkillsByAbility(owner.skillBreakdown)
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
