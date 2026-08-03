import { readFileSync } from "node:fs";

import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

// The REAL shipped skill-groups table, not a stub — this check exists to prove
// the fold lands on the tables the app actually ships. `src/test/setup.ts`
// already mocks that module with exactly that table, so there is nothing to
// override here.
import type { AbilityChartSeries } from "@/types";
import { getSkillName } from "@/utils";

import { foldAbilityChart } from "./drillSeries";

beforeAll(async () => {
  const ui = JSON.parse(readFileSync("src-tauri/lang/en/ui.json", "utf-8"));
  await i18n.init({ lng: "en", resources: { en: { translation: ui } }, interpolation: { escapeValue: false } });
});

const band = (action: number, total: number): AbilityChartSeries =>
  ({ actionType: { Normal: action }, childCharacterType: "Pl0000", values: [total] }) as AbilityChartSeries;

describe("foldAbilityChart against the real tables", () => {
  it("collapses Gran's raw actions into named groups", () => {
    // Pl0000: 100/110/120 are "normal-attack", 200/201 are "power-raise".
    const folded = foldAbilityChart(
      [band(100, 10), band(110, 20), band(120, 30), band(200, 5), band(201, 5)],
      "Pl0000",
      getSkillName
    );

    expect(folded).toHaveLength(2);
    expect(folded[0].label).toBe("Normal Attack");
    expect(folded[0].values).toEqual([60]);
    expect(folded[1].label).toBe("Power Raise");
  });
});
