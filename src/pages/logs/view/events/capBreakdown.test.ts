import { describe, expect, it } from "vitest";

import {
  PREDICTED_CAP_DENYLIST,
  capCardRows,
  capPredictableKey,
  predictedCapRows,
  selectCapUp,
  type CapContext,
} from "./capBreakdown";

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

const context = (over: Partial<CapContext> = {}): CapContext => ({
  ladderBase: null,
  verdict: null,
  record: null,
  recordComponents: [],
  dmgCapTrait: 0,
  conditional: [],
  ...over,
});

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

  // The game's own ladder gives the base INDEPENDENTLY of any cap-up model,
  // which is what makes every number below it falsifiable: the game's total is
  // cap / base − 1 per hit, and the attributed terms must reconcile against it.
  describe("with the ladder base", () => {
    // A real capped hit from the 2026-08-08 capture: cap 152737 at ladder base
    // 5399 is the game's own +2729%.
    const real = { ...hit, damage_cap: 152_737 };

    it("reports the real base and the game's per-hit total", () => {
      const rows = capCardRows(real, context({ ladderBase: 5399, verdict: "pass" }));
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(byKey["basecap"]).toBe(5399);
      expect(byKey["gamecapup"]).toBeCloseTo(2729, 0);
    });

    it("carries the formula verdict as its own row", () => {
      const rows = capCardRows(real, context({ ladderBase: 5399, verdict: "pass" }));
      expect(rows.find((r) => r.key === "verdict")).toEqual({
        key: "verdict",
        labelKey: "ui.logs.cap-formula-check",
        value: 1,
        kind: "verdict",
      });
      const bad = capCardRows(real, context({ ladderBase: 5399, verdict: "fail" }));
      expect(bad.find((r) => r.key === "verdict")?.value).toBe(0);
    });

    it("renders the ease as its own verdict state and relabels the remainder", () => {
      // A mid-ease hit is the game's own arithmetic passing between the
      // actor's grid states: value 2 (the ⇄ mark), and what the attribution
      // cannot explain is the easing gap, not an unaccounted term.
      for (const verdict of ["transition", "settling"] as const) {
        const rows = capCardRows(real, context({ ladderBase: 5399, verdict }));
        expect(rows.find((r) => r.key === "verdict")?.value).toBe(2);
        const remainder = rows.find((r) => r.key === "unaccounted");
        expect(remainder?.labelKey).toBe("ui.logs.cap-easing-gap");
      }
      const passing = capCardRows(real, context({ ladderBase: 5399, verdict: "pass" }));
      expect(passing.find((r) => r.key === "unaccounted")?.labelKey).toBe("ui.logs.cap-unaccounted");
    });

    it("attributes the captured record and the DMG Cap trait against the game total", () => {
      const rows = capCardRows(
        real,
        context({
          ladderBase: 5399,
          verdict: "pass",
          record: 18.96,
          dmgCapTrait: 2.38,
          recordComponents: [{ key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", value: 0.2 }],
        })
      );
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
      expect(byKey["capup"].value).toBeCloseTo(1896, 0);
      expect(byKey["dmgcap"].value).toBeCloseTo(238, 0);
      // 27.29... − 18.96 − 2.38 = 5.95...
      expect(byKey["unaccounted"].value).toBeCloseTo(595, 0);
      // The record's components are sub-rows of the captured number, NOT terms:
      // the record already contains them, so they never join the sum.
      expect(byKey["overmastery"].variant).toBe("sub");
    });

    it("renders conditional sources excluded from the attribution", () => {
      const rows = capCardRows(
        real,
        context({
          ladderBase: 5399,
          verdict: "pass",
          record: 18.96,
          conditional: [{ key: "conditional-1e1cecce", labelKey: "", traitId: 0x1e1cecce, value: 5.0 }],
        })
      );
      const conditional = rows.find((r) => r.key === "conditional-1e1cecce");
      expect(conditional?.variant).toBe("conditional");
      expect(conditional?.value).toBeCloseTo(500, 0);
      // Unaccounted ignores the conditional's maximum: 27.29… − 18.96.
      expect(rows.find((r) => r.key === "unaccounted")?.value).toBeCloseTo(833, 0);
    });

    it("shows the unaccounted row even when nothing is attributed", () => {
      const rows = capCardRows(real, context({ ladderBase: 5399, verdict: "pass" }));
      expect(rows.find((r) => r.key === "unaccounted")?.value).toBeCloseTo(2729, 0);
    });

    it("credits derived channel sources against the game total", () => {
      // The per-hit FreeWork channel (board cap nodes) is NOT inside the
      // captured record — log 2573's oracle reconciliation — so a derived
      // channel total is attributed as its own term beside the record.
      const rows = capCardRows(
        real,
        context({
          ladderBase: 5399,
          verdict: "pass",
          record: 18.96,
          channel: [{ key: "channel", labelKey: "ui.logs.cap-term-channel", value: 4.35 }],
        })
      );
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
      expect(byKey["channel"].value).toBeCloseTo(435, 0);
      expect(byKey["channel"].variant).toBeUndefined();
      // 27.29… − 18.96 − 4.35 = 3.98…
      expect(byKey["unaccounted"].value).toBeCloseTo(398, 0);
    });

    it("never credits channel sources against the bare record fallback", () => {
      // Without the ladder the card's total IS the record, and the channel is
      // not part of the record — crediting it there would subtract a term from
      // a total that never contained it.
      const rows = capCardRows(
        real,
        context({ record: 18.96, channel: [{ key: "channel", labelKey: "ui.logs.cap-term-channel", value: 4.35 }] })
      );
      expect(rows.find((r) => r.key === "channel")).toBeUndefined();
    });
  });

  // Old logs carry the captured record but predate the fields the ladder needs
  // (rate, class flags, character) — the record is the best total available.
  describe("without the ladder base", () => {
    it("derives the base cap from the captured record", () => {
      const rows = capCardRows(hit, context({ record: 13.13 }));
      expect(rows.find((r) => r.key === "basecap")?.value).toBeCloseTo(1_000_000 / 14.13, 0);
      expect(rows.find((r) => r.key === "capup")?.value).toBeCloseTo(1313, 0);
    });

    it("reconciles the components against the record instead", () => {
      const rows = capCardRows(
        hit,
        context({
          record: 13.13,
          recordComponents: [{ key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", value: 0.5 }],
        })
      );
      expect(rows.find((r) => r.key === "unaccounted")?.value).toBeCloseTo(1263, 0);
    });

    it("emits no verdict — there is nothing independent to check against", () => {
      const rows = capCardRows(hit, context({ record: 13.13 }));
      expect(rows.some((r) => r.key === "verdict")).toBe(false);
    });

    it("keeps the Stage-1 rows when nothing at all is known", () => {
      expect(capCardRows(hit).some((r) => r.key === "unaccounted")).toBe(false);
      expect(capCardRows(hit, context()).some((r) => r.key === "unaccounted")).toBe(false);
    });
  });
});

describe("capPredictableKey", () => {
  it("accepts exactly the kinds that locally always carry cap fields", () => {
    expect(capPredictableKey("Normal:100")).toBe(true);
    expect(capPredictableKey("LinkAttack")).toBe(true);
    expect(capPredictableKey("SBA")).toBe(true);
  });

  it("rejects the kinds that never do", () => {
    expect(capPredictableKey("SupplementaryDamage:100")).toBe(false);
    expect(capPredictableKey("DamageOverTime:1")).toBe(false);
    expect(capPredictableKey("PerfectGuard")).toBe(false);
    expect(capPredictableKey(null)).toBe(false);
    expect(capPredictableKey("garbage")).toBe(false);
  });
});

describe("predictedCapRows", () => {
  const capless = { damage: 80_000, damage_cap: null, base_damage: null, attack_rate: 0.54, class_flags: 0x1 };
  const predictedContext = {
    ladderBase: 5_399,
    record: 13.13,
    dmgCapTrait: 2.5,
    channelActive: 0.15,
    channelUnresolved: 0,
    recordComponents: [{ key: "trait", labelKey: "ui.logs.cap-family-traits", value: 0.5 }],
    conditional: [{ key: "conditional-1e1cecce", labelKey: "", traitId: 0x1e1cecce, value: 5 }],
  };

  it("predicts trunc(base x (1 + record + dmgCap + activeChannel))", () => {
    const rows = predictedCapRows(capless, predictedContext);
    const predicted = rows.find((row) => row.key === "predicted");
    // 5399 x (1 + 13.13 + 2.5 + 0.15) = 5399 x 16.78 = 90,595.22
    expect(predicted).toMatchObject({ value: 90_595, kind: "count", approx: true });
  });

  it("renders the terms it summed and the potentials it did not", () => {
    const keys = predictedCapRows(capless, predictedContext).map((row) => row.key);
    expect(keys).toEqual([
      "damage",
      "predicted",
      "mv",
      "basecap",
      "capup",
      "trait",
      "dmgcap",
      "channel",
      "conditional-1e1cecce",
    ]);
  });

  it("adds the unresolved row only when channel factors are actually open", () => {
    const rows = predictedCapRows(capless, { ...predictedContext, channelUnresolved: 0.3 });
    const unresolved = rows.find((row) => row.key === "unresolved");
    // Rendered as a potential (the conditional grammar), never summed into the
    // predicted figure, which stays the resolved-terms product.
    expect(unresolved).toMatchObject({ value: 30, kind: "percent", variant: "conditional" });
    expect(rows.find((row) => row.key === "predicted")?.value).toBe(90_595);
  });

  it("omits the zero-value optional rows rather than claiming zeroes", () => {
    const rows = predictedCapRows(capless, {
      ...predictedContext,
      dmgCapTrait: 0,
      channelActive: 0,
      recordComponents: [],
      conditional: [],
    });
    expect(rows.map((row) => row.key)).toEqual(["damage", "predicted", "mv", "basecap", "capup"]);
  });

  it("returns nothing for a base or total the formula cannot have used", () => {
    expect(predictedCapRows(capless, { ...predictedContext, ladderBase: 0 })).toEqual([]);
    // 1 + (-4) + 2.5 + 0.15 <= 0: a multiplier the formula cannot produce.
    expect(predictedCapRows(capless, { ...predictedContext, record: -4 })).toEqual([]);
  });
});

describe("PREDICTED_CAP_DENYLIST", () => {
  it("withholds the characters the formula is known-incomplete for", () => {
    // Fediel (unknown constant source), Rosetta (constant ~27% undershoot),
    // Seofon (~5x overprediction) — the 2026-08-13 blind sweep's verdicts.
    expect(PREDICTED_CAP_DENYLIST.has("Pl2900")).toBe(true);
    expect(PREDICTED_CAP_DENYLIST.has("Pl0600")).toBe(true);
    expect(PREDICTED_CAP_DENYLIST.has("Pl2200")).toBe(true);
    expect(PREDICTED_CAP_DENYLIST.has("Pl0300")).toBe(false);
  });
});
