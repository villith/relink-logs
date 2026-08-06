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

  // Stun, not damage — the card read `totalDamage` for every metric, so a stun
  // bar's tooltip explained it with damage figures under a "DMG" heading.
  //
  // `perTarget: false`: `SkillTargetState` carries damage and hits only, so
  // there is no per-enemy stun to report and the card offers no target
  // section rather than filling one from the wrong figure.
  card: {
    amountKey: "ui.skill-columns.stun",
    valueOf: (skill) => skill.totalStunValue,
    format: oneDecimal,
    perTarget: false,
  },

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

    // Condensed into skill-group rows until a group is PINNED, at which point
    // the rows become that group's members.
    //
    // Keyed off the pin rather than off `level`, unlike damage: `levelFor` only
    // yields "skills" for the target dimension, and stun has none (see
    // CAPABILITIES), so the member view was unreachable and pinning a group
    // merely re-folded it into the single row that had just been clicked.
    // Damage descends through its target dimension; the ability pin is the only
    // descent these tabs have.
    //
    // Totals add; the max is the biggest single hit, so it takes the largest
    // rather than summing.
    const fold = pins.ability === null && level === "abilities" ? groupSkillsForRows : mergeSkillsByAction;

    return (
      fold(breakdown)
        .map(({ key, skills }) => {
          const total = skills.reduce((sum, skill) => sum + skill.totalStunValue, 0);
          return {
            key: `skill:${key}`,
            label: key,
            value: total,
            columns: [oneDecimal(total), oneDecimal(Math.max(...skills.map((skill) => skill.maxStunValue)))],
            // Once the rows ARE the pinned group's members there is nothing
            // further to descend into, so they carry no pin of their own.
            pinOnClick: level === "abilities" && pins.ability === null ? { ability: key } : null,
            colorSlot,
          };
        })
        // Most of a rotation applies no stun at all, or lands while the enemy is
        // already stunned — listing those is a wall of honest zeros (the same rule
        // `sba` applies to its attributed rows). Filtered on the VALUE, not the
        // rendered column, so a genuinely tiny accrual that rounds to "0.0" is
        // kept rather than quietly dropped out of the total above it.
        .filter((row) => row.value !== 0)
        .sort((a, b) => b.value - a.value)
    );
  },
};
