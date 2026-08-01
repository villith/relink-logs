import { abilityKey } from "../abilityKey";
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

    return [...owner.skillBreakdown]
      .sort((a, b) => b.totalStunValue - a.totalStunValue)
      .map((skill) => ({
        key: `skill:${abilityKey(skill.actionType)}`,
        label: abilityKey(skill.actionType),
        value: skill.totalStunValue,
        columns: [oneDecimal(skill.totalStunValue), oneDecimal(skill.maxStunValue)],
        pinOnClick: level === "abilities" ? { ability: abilityKey(skill.actionType) } : null,
        colorSlot: owner.partyIndex,
      }));
  },
};
