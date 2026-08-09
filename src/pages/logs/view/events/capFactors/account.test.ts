import { describe, expect, it } from "vitest";

import type { CapLoadout } from "../capSources";
import { accountFactors } from "./account";

const loadout = (masterLevel: number | undefined): CapLoadout => ({
  sigils: [],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
  masterLevel,
});

const rank = (masterLevel: number | undefined) => {
  const factor = accountFactors(loadout(masterLevel)).find((entry) => entry.key === "account-master-rank");
  if (factor === undefined) throw new Error("no master-rank factor");
  return factor.evaluate({});
};

describe("master trait rank bonus", () => {
  it("is the running sum of every level's increment", () => {
    // The table grants at levels 2,5,10,15,20,25,30,35,40,45,50 —
    // 5,5,6,6,7,7,10,10,12,12,20 — so the totals ladder up like this.
    expect(rank(10)).toMatchObject({ percent: 16, state: "active" });
    expect(rank(20)).toMatchObject({ percent: 29, state: "active" });
    expect(rank(30)).toMatchObject({ percent: 46, state: "active" });
    expect(rank(40)).toMatchObject({ percent: 68, state: "active" });
    expect(rank(50)).toMatchObject({ percent: 100, state: "active" });
  });

  it("grants nothing before the first breakpoint", () => {
    expect(rank(1)).toMatchObject({ percent: 0, state: "active" });
  });

  it("does not count a partial level toward the next breakpoint", () => {
    // Level 4 has not reached the level-5 increment.
    expect(rank(4)).toMatchObject({ percent: 5, state: "active" });
  });

  it("clamps master-break stars, which grant no further cap", () => {
    // masterLevel is level and stars COMBINED (55 = level 50 + 5 stars), and
    // the table stops at 50 — reading past it would walk off the end.
    expect(rank(55)).toMatchObject({ percent: 100, state: "active" });
  });

  it("stays unresolved for a record that never captured a master level", () => {
    // AI companions read 0. Valuing that as +0% would claim they have no rank
    // bonus, which is a stronger statement than "this log cannot say".
    expect(rank(0)).toMatchObject({ state: "unknown", reason: "value-unrecorded" });
    expect(rank(undefined)).toMatchObject({ state: "unknown", reason: "value-unrecorded" });
  });
});

describe("mastery / collection", () => {
  it("stays unresolved — the tables value it but the log has no node set", () => {
    const factor = accountFactors(loadout(50)).find((entry) => entry.key === "account-mastery");
    expect(factor?.evaluate({})).toMatchObject({ state: "unknown" });
  });
});
