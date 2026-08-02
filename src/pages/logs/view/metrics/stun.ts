import { groupSkillsForRows, mergeSkillsByAction } from "../abilitySkills";
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

    // Same rule as `damageDone`: a pinned-but-absent source is empty, while NO
    // pinned source widens the scope to the whole party without changing what a
    // row is.
    const owner = pins.source === null ? null : players.find((p) => p.index === pins.source);
    if (pins.source !== null && !owner) return [];

    const breakdown = owner ? owner.skillBreakdown : players.flatMap((p) => p.skillBreakdown);
    const colorSlot = owner ? owner.partyIndex : -1;

    // Condensed into skill-group rows at the abilities level — see
    // `abilityRowKey` — and NOT condensed one level down, where the rows are the
    // pinned group's members. Totals add; the max is the biggest single hit, so
    // it takes the largest rather than summing.
    const fold = level === "abilities" ? groupSkillsForRows : mergeSkillsByAction;

    return fold(breakdown)
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

