import { humanizeNumbers } from "@/utils";

import { abilityKey } from "../abilityKey";
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
  // means little, so the second column becomes how often it landed. Share is
  // last in both cases, of whatever the level's total is.
  columnKeys: (level) =>
    level === "players"
      ? ["ui.meter-columns.damage", "ui.meter-columns.dps", "ui.logs.column-share"]
      : ["ui.skill-columns.total", "ui.skill-columns.hits", "ui.logs.column-share"],

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

    return [...owner.skillBreakdown]
      .sort((a, b) => b.totalDamage - a.totalDamage)
      .map((skill) => ({
        key: `skill:${abilityKey(skill.actionType)}`,
        label: abilityKey(skill.actionType),
        value: skill.totalDamage,
        columns: [format(skill.totalDamage), String(skill.hits), share(skill.totalDamage, owner.totalDamage)],
        pinOnClick: level === "abilities" ? { ability: abilityKey(skill.actionType) } : null,
        colorSlot: owner.partyIndex,
      }));
  },
};
