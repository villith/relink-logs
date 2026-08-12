import { describe, expect, it } from "vitest";

import type { EquippedSummon, Overmastery } from "@/types";

import type { CapLoadout } from "../capSources";
import { overmasteryFactors, summonFactors } from "./equipment";

/** utils.ts' OVERMASTERY_EFFECT_IDS representatives, one per class. */
const OM_NORMAL = 0x06595c52;
const OM_SKILL = 0x0b0e4311;
/** An ATK roll — real, but not a cap source. */
const OM_NOT_A_CAP = 0x0badf00d;
/** "Normal Attack Damage Cap Up" as a summon equip bonus. */
const SUMMON_BONUS_NORMAL = 0x9245dfa4;

const summon = (bonusId: number, bonusLevel: number): EquippedSummon => ({
  summonId: 1,
  mainTraitId: 0,
  mainTraitLevel: 0,
  bonusId,
  bonusLevel,
});

const loadout = (over: Partial<CapLoadout> = {}): CapLoadout => ({
  sigils: [],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
  ...over,
});

const withRolls = (...overmasteries: Overmastery[]): CapLoadout => loadout({ overmasteryInfo: { overmasteries } });

describe("overmastery factors", () => {
  it("take the magnitude off the log, since the game already computed it", () => {
    const [factor] = overmasteryFactors(withRolls({ id: OM_NORMAL, flags: 0, value: 20 }), "normal");
    expect(factor.params).toEqual([]);
    expect(factor.evaluate({})).toMatchObject({ percent: 20, state: "active" });
  });

  it("reject a roll that raises a different class", () => {
    const [factor] = overmasteryFactors(withRolls({ id: OM_SKILL, flags: 0, value: 20 }), "normal");
    expect(factor.evaluate({})).toMatchObject({ state: "not-applicable", reason: "other-class" });
  });

  it("reject a roll that is not a cap source at all", () => {
    const [factor] = overmasteryFactors(withRolls({ id: OM_NOT_A_CAP, flags: 0, value: 20 }), "normal");
    expect(factor.evaluate({})).toMatchObject({ state: "not-applicable", reason: "not-a-cap-source" });
  });

  it("leave a roll whose magnitude was never captured unattributed, not zero", () => {
    // A v2.0.2 town-loadout recovery carries the roll but not its value.
    // Counting it as zero would claim it contributed nothing.
    const [factor] = overmasteryFactors(withRolls({ id: OM_NORMAL, flags: 0, value: 0 }), "normal");
    expect(factor.evaluate({})).toMatchObject({ state: "unknown", reason: "value-unrecorded" });
  });

  it("key duplicate rolls apart", () => {
    // A player can roll the same overmastery twice, and two rows sharing a key
    // would collide in the rendered list.
    const factors = overmasteryFactors(
      withRolls({ id: OM_NORMAL, flags: 0, value: 20 }, { id: OM_NORMAL, flags: 0, value: 15 }),
      "normal"
    );
    expect(new Set(factors.map((factor) => factor.key)).size).toBe(2);
  });
});

describe("summon bonus factors", () => {
  it("read the shipped per-level value", () => {
    // `bonusLevel` indexes the shipped values array directly, so level 0 is the
    // first row (+20%) and level 1 the second (+25%).
    const [first] = summonFactors(loadout({ summons: [summon(SUMMON_BONUS_NORMAL, 0)] }), "normal");
    expect(first.evaluate({})).toMatchObject({ percent: 20, state: "active" });
    const [second] = summonFactors(loadout({ summons: [summon(SUMMON_BONUS_NORMAL, 1)] }), "normal");
    expect(second.evaluate({})).toMatchObject({ percent: 25, state: "active" });
  });

  it("reject a bonus that raises a different class", () => {
    const [factor] = summonFactors(loadout({ summons: [summon(SUMMON_BONUS_NORMAL, 1)] }), "skill");
    expect(factor.evaluate({})).toMatchObject({ state: "not-applicable", reason: "other-class" });
  });
});
