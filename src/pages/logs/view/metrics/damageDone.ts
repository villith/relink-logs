import { humanizeNumbers } from "@/utils";

import { abilityKey } from "../abilityKey";
import type { MetricDescriptor, MetricRow } from "./types";

const format = (value: number): string => {
  const [n, suffix] = humanizeNumbers(value);
  return `${n}${suffix}`;
};

export const damageDone: MetricDescriptor = {
  labelKey: "ui.logs.metric-damage-done",

  // Players are ranked by damage and rate; below that a rate over one skill
  // means little, so the second column becomes how often it landed.
  columnKeys: (level) =>
    level === "players"
      ? ["ui.meter-columns.damage", "ui.meter-columns.dps"]
      : ["ui.skill-columns.total", "ui.skill-columns.hits"],

  labelKind: (level) => (level === "players" ? "player" : "ability"),

  rows: ({ players, level, pins }): MetricRow[] => {
    if (level === "players") {
      return [...players]
        .sort((a, b) => b.totalDamage - a.totalDamage)
        .map((p) => ({
          key: `player:${p.index}`,
          label: String(p.index),
          value: p.totalDamage,
          columns: [format(p.totalDamage), format(p.dps)],
          pinOnClick: { source: p.index },
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
        columns: [format(skill.totalDamage), String(skill.hits)],
        pinOnClick: level === "abilities" ? { ability: abilityKey(skill.actionType) } : null,
      }));
  },
};
