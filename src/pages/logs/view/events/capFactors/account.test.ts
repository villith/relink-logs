import { describe, expect, it } from "vitest";

import type { CapLoadout } from "../capSources";
import { accountFactors } from "./account";

const loadout = (masterLevel: number | undefined, overrides: Partial<CapLoadout> = {}): CapLoadout => ({
  sigils: [],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
  masterLevel,
  ...overrides,
});

const rank = (masterLevel: number | undefined) => {
  const factor = accountFactors(loadout(masterLevel), "skill").find((entry) => entry.key === "account-master-rank");
  if (factor === undefined) throw new Error("no master-rank factor");
  return factor.evaluate({});
};

const factorResult = (key: string, player: CapLoadout, capClass: Parameters<typeof accountFactors>[1]) => {
  const factor = accountFactors(player, capClass).find((entry) => entry.key === key);
  if (factor === undefined) throw new Error(`no ${key} factor`);
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

/** A weapon whose only AP tree is the weapon tree, worth +10% to skill and to
 * Skybound Art caps — small enough that a total cannot be confused with the
 * character's. */
const weapon = (weaponId: number) => ({
  weaponId,
  starLevel: 0,
  plusMarks: 0,
  awakeningLevel: 0,
  trait1Id: 0,
  trait1Level: 0,
  trait2Id: 0,
  trait2Level: 0,
  trait3Id: 0,
  trait3Level: 0,
  wrightstoneId: 0,
  weaponLevel: 0,
  weaponHp: 0,
  weaponAttack: 0,
});

describe("mastery / collection", () => {
  const player = loadout(50, { characterType: "Pl0000", weaponInfo: weapon(0x10180036) });

  it("stays unresolved — the tables value it, but the log has no unlocked-node set", () => {
    expect(factorResult("account-mastery", player, "skill")).toMatchObject({
      state: "unknown",
      percent: 0,
      reason: "unlocks-unrecorded",
    });
  });

  it("carries the completed character trees as its potential, so the row names a size", () => {
    expect(factorResult("account-mastery", player, "skill").potential).toBe(150);
    expect(factorResult("account-mastery", player, "sba").potential).toBe(150);
  });

  it("offers nothing to a normal attack — no AP-tree node raises that cap", () => {
    expect(factorResult("account-mastery", player, "normal").potential).toBe(0);
  });

  it("says nothing at all when the class or the character is unknown", () => {
    expect(factorResult("account-mastery", player, null).potential).toBe(0);
    expect(factorResult("account-mastery", loadout(50), "skill").potential).toBe(0);
  });
});

describe("weapon mastery trees", () => {
  it("follows the EQUIPPED weapon rather than the character", () => {
    const player = loadout(50, { characterType: "Pl0000", weaponInfo: weapon(0x10180036) });
    expect(factorResult("account-weapon-trees", player, "skill")).toMatchObject({
      state: "unknown",
      potential: 10,
      reason: "unlocks-unrecorded",
    });
  });

  it("is zero for a log with no stored weapon, not the character's number", () => {
    const player = loadout(50, { characterType: "Pl0000" });
    expect(factorResult("account-weapon-trees", player, "skill").potential).toBe(0);
  });
});
