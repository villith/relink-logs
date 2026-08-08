import { describe, expect, it } from "vitest";

import { capCardRows } from "./capBreakdown";

const hit = {
  damage: 1_500_000,
  damage_cap: 1_000_000,
  base_damage: 4_000_000,
  attack_rate: 2.5,
};

describe("capCardRows", () => {
  it("reports the logged cap, the MV and the derived multiplier", () => {
    expect(capCardRows(hit)).toEqual([
      { key: "damage", labelKey: "ui.logs.cap-damage-dealt", value: 1_500_000, kind: "count" },
      { key: "cap", labelKey: "ui.logs.cap-logged", value: 1_000_000, kind: "count" },
      { key: "mv", labelKey: "ui.logs.cap-mv", value: 2.5, kind: "rate" },
      { key: "base", labelKey: "ui.logs.cap-precap-base", value: 4_000_000, kind: "count" },
      { key: "overcap", labelKey: "ui.logs.cap-overcap", value: 400, kind: "percent" },
      { key: "postcap", labelKey: "ui.logs.cap-postcap-mult", value: 1.5, kind: "multiplier" },
    ]);
  });

  it("drops the derived rows when the hit carries no cap", () => {
    const rows = capCardRows({ ...hit, damage_cap: null, base_damage: null, attack_rate: null });
    expect(rows.map((r) => r.key)).toEqual(["damage"]);
  });

  it("divides an UNCAPPED hit by its base, not by the cap", () => {
    // base < cap, so the clamp never bound; dividing by the cap would
    // understate the multiplier (0.7 instead of 1.167).
    const rows = capCardRows({ ...hit, base_damage: 600_000, damage: 700_000 });
    expect(rows.find((r) => r.key === "overcap")?.value).toBeCloseTo(60, 2);
    expect(rows.find((r) => r.key === "postcap")?.value).toBeCloseTo(1.167, 3);
  });
});
