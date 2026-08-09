import { describe, expect, it } from "vitest";

import { capCardRows, selectCapUp } from "./capBreakdown";

describe("selectCapUp", () => {
  const capUp = { normal: 13.13, skill: 15.18, sba: 12.16 };

  it("picks the cap-up for the hit's attack class", () => {
    expect(selectCapUp(capUp, 0x1)).toBe(13.13);
    expect(selectCapUp(capUp, 0x10008)).toBe(15.18);
  });

  // The builder tests 0x10000 first, but the 0x40000 branch jumps past the
  // skill assignment — so a hit carrying both is a Skybound Art.
  it("lets Skybound Art win over Skill", () => {
    expect(selectCapUp(capUp, 0x50000)).toBe(12.16);
  });

  it("has no answer without a class or without a captured cap-up", () => {
    expect(selectCapUp(capUp, null)).toBeNull();
    expect(selectCapUp(undefined, 0x1)).toBeNull();
    // The class resolved, but THAT class was never captured. Falling back to
    // another class's number would attribute the wrong total.
    expect(selectCapUp({ normal: null, skill: 15.18, sba: null }, 0x1)).toBeNull();
  });
});

const hit = {
  damage: 1_500_000,
  damage_cap: 1_000_000,
  base_damage: 4_000_000,
  attack_rate: 2.5,
  class_flags: 0x1,
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

  // The game hands us ONE fused cap-up number, not its sources. Deriving the
  // sources from the stored loadout and subtracting gives the gap — which is
  // the whole point of the unaccounted row, and is the entire total until a
  // source lands.
  describe("itemized cap-up", () => {
    const capUp = { totalCapUp: 13.13, terms: [] };

    it("reconciles the derived sources against the game's own total", () => {
      const rows = capCardRows(hit, {
        totalCapUp: 13.13,
        terms: [
          { key: "om-1", labelKey: "ui.logs.cap-source-overmastery", value: 0.5 },
          { key: "summon-1", labelKey: "ui.logs.cap-source-summon", value: 0.35 },
        ],
      });
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(byKey["capup"]).toBeCloseTo(1313, 2);
      expect(byKey["om-1"]).toBeCloseTo(50, 2);
      expect(byKey["summon-1"]).toBeCloseTo(35, 2);
      // 13.13 - 0.5 - 0.35 = 12.28
      expect(byKey["unaccounted"]).toBeCloseTo(1228, 2);
    });

    it("reports the whole total as unaccounted when no source is derived yet", () => {
      const rows = capCardRows(hit, capUp);
      const unaccounted = rows.find((r) => r.key === "unaccounted");
      expect(unaccounted?.value).toBeCloseTo(1313, 2);
    });

    it("shows the unaccounted row even when it is the largest number on the card", () => {
      // Hiding it exactly when the model is doing badly is when the reader most
      // needs to see it.
      const rows = capCardRows(hit, capUp);
      expect(rows.some((r) => r.key === "unaccounted")).toBe(true);
    });

    it("derives the base cap from the game's total, not from the derived sources", () => {
      // Sources are a partial reconstruction; dividing by them would overstate
      // the base. The game's own multiplier is 1 + 13.13.
      const rows = capCardRows(hit, capUp);
      const base = rows.find((r) => r.key === "basecap");
      expect(base?.value).toBeCloseTo(1_000_000 / 14.13, 0);
    });

    it("keeps the Stage-1 rows when no cap-up is known at all", () => {
      expect(capCardRows(hit).some((r) => r.key === "unaccounted")).toBe(false);
    });
  });

  it("divides an UNCAPPED hit by its base, not by the cap", () => {
    // base < cap, so the clamp never bound; dividing by the cap would
    // understate the multiplier (0.7 instead of 1.167).
    const rows = capCardRows({ ...hit, base_damage: 600_000, damage: 700_000 });
    expect(rows.find((r) => r.key === "overcap")?.value).toBeCloseTo(60, 2);
    expect(rows.find((r) => r.key === "postcap")?.value).toBeCloseTo(1.167, 3);
  });
});
