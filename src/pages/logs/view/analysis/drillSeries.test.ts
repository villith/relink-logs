import { describe, expect, it, vi } from "vitest";

// Resolved through Tauri's resource API at import time, which jsdom has not.
vi.mock("@/assets/skill-groups", () => ({
  default: { Pl0000: { "normal-attack": { skills: [100, 110] }, "power-raise": { skills: [200] } } },
}));

import type { AbilityChartSeries, CharacterType, EnemyType, SkillRow, TargetChartSeries } from "@/types";

import { foldAbilityChart, foldTargetChart } from "./drillSeries";

const band = (action: number, values: number[], child = "Pl0000"): AbilityChartSeries =>
  ({ actionType: { Normal: action }, childCharacterType: child, values }) as AbilityChartSeries;

/** Names a group by its key and a raw skill by its action id, so a test can see
 * which path produced a label. */
const SKILL_NAME = (_characterType: CharacterType, skill: SkillRow) => {
  const action = skill.actionType;
  if (typeof action === "object" && "Group" in action) return `group:${action.Group}`;
  if (typeof action === "object" && "Normal" in action) return `skill:${action.Normal}`;
  return String(action);
};

describe("foldAbilityChart", () => {
  it("sums a group's members into one band, bucket by bucket", () => {
    const folded = foldAbilityChart([band(100, [10, 0, 5]), band(110, [1, 2, 3])], "Pl0000", SKILL_NAME);

    expect(folded).toHaveLength(1);
    expect(folded[0].values).toEqual([11, 2, 8]);
    expect(folded[0].label).toBe("group:normal-attack");
  });

  it("keeps an ungrouped action as its own band, named as itself", () => {
    // Link attacks never group; the map is keyed by skill id.
    const link = { actionType: "LinkAttack", childCharacterType: "Pl0000", values: [7, 7] } as AbilityChartSeries;
    const folded = foldAbilityChart([link], "Pl0000", SKILL_NAME);

    expect(folded[0].label).toBe("LinkAttack");
    expect(folded[0].values).toEqual([7, 7]);
  });

  it("orders bands by total, biggest first, matching the table", () => {
    const folded = foldAbilityChart([band(200, [1, 1]), band(100, [50, 50])], "Pl0000", SKILL_NAME);

    expect(folded.map((series) => series.label)).toEqual(["group:normal-attack", "group:power-raise"]);
  });

  it("gives every band a distinct key even when two share a label", () => {
    const folded = foldAbilityChart([band(100, [1]), band(100, [2], "Pl0700Ghost")], "Pl0000", SKILL_NAME);

    expect(new Set(folded.map((series) => series.key)).size).toBe(folded.length);
  });

  it("returns nothing for no bands, rather than an empty band", () => {
    expect(foldAbilityChart([], "Pl0000", SKILL_NAME)).toEqual([]);
  });
});

describe("foldTargetChart", () => {
  const label = (enemyType: EnemyType, instance: number) =>
    `${typeof enemyType === "string" ? enemyType : `unknown-${enemyType.Unknown}`} #${instance}`;

  it("labels each spawn through the shared target rule", () => {
    const series: TargetChartSeries[] = [
      { enemyType: "Em0100", instance: 1, values: [5, 5] },
      { enemyType: "Em0100", instance: 2, values: [1, 0] },
    ];

    const folded = foldTargetChart(series, label);

    expect(folded.map((s) => s.label)).toEqual(["Em0100 #1", "Em0100 #2"]);
    expect(folded[0].values).toEqual([5, 5]);
  });

  it("keys unknown enemy types apart from each other", () => {
    const series: TargetChartSeries[] = [
      { enemyType: { Unknown: 1 }, instance: 1, values: [1] },
      { enemyType: { Unknown: 2 }, instance: 1, values: [1] },
    ];

    const folded = foldTargetChart(series, label);

    expect(new Set(folded.map((s) => s.key)).size).toBe(2);
  });
});
