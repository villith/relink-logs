import { groupSkillsByAbility } from "../abilitySkills";
import type { MetricDescriptor, MetricRow } from "./types";

const oneDecimal = (value: number): string => value.toFixed(1);

export const stun: MetricDescriptor = {
  labelKey: "ui.logs.metric-stun",

  columnKeys: (level) =>
    level === "players"
      ? ["ui.meter-columns.total-stun-value", "ui.meter-columns.stun-per-second"]
      : ["ui.skill-columns.stun", "ui.skill-columns.max"],

  labelKind: (level) => (level === "players" ? "player" : "ability"),

  rows: ({ players, level, pins }): MetricRow[] => {
    if (level === "players") {
      return [...players]
        .sort((a, b) => b.totalStunValue - a.totalStunValue)
        .map((p) => ({
          key: `player:${p.index}`,
          label: String(p.index),
          value: p.totalStunValue,
          columns: [oneDecimal(p.totalStunValue), oneDecimal(p.stunPerSecond)],
          pinOnClick: { source: p.index },
          colorSlot: p.partyIndex,
        }));
    }

    const owner = players.find((p) => p.index === pins.source);
    if (!owner) return [];

    // Grouped, not mapped 1:1 — see `groupSkillsByAbility`. Totals add; the max
    // is the biggest single hit, so it takes the largest rather than summing.
    return groupSkillsByAbility(owner.skillBreakdown)
      .map(({ key, skills }) => ({
        key: `skill:${key}`,
        label: key,
        value: skills.reduce((sum, skill) => sum + skill.totalStunValue, 0),
        columns: [
          oneDecimal(skills.reduce((sum, skill) => sum + skill.totalStunValue, 0)),
          oneDecimal(Math.max(...skills.map((skill) => skill.maxStunValue))),
        ],
        pinOnClick: level === "abilities" ? { ability: key } : null,
        colorSlot,
      }))
      .sort((a, b) => b.value - a.value);
  },
};
