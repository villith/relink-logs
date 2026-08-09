import { describe, expect, it } from "vitest";

import type { Sigil } from "@/types";
import { toHashString } from "@/utils";

import type { CapLoadout } from "../capSources";
import { traitFactors } from "./traits";

/** Unconditional: +50% to every class at level 15. */
const FATEBREAKER = 0xd029fe08;
/** Unconditional, skill only. */
const UNBOUND_TECHNIQUE = 0x020db733;
/** The plain DMG Cap trait — its own term outside the record. */
const DMG_CAP = 0xdc584f60;
/** "While at 75% HP or more: ATK +20% / DMG Cap +70%" at level 15. */
const CELESTIAL_LUMEN = 0xa7726190;
/** "While at 25% HP or less: ... DMG Cap +120%" at level 15. */
const CELESTIAL_NYX = 0x0de887a0;
/** "When at 45000 max HP or less: ... DMG Cap +100%" at level 25. */
const CATASTROPHE = 0x40223c28;
/** Min +220% at 100% crit, max +270% at 200% crit, at level 15. */
const COBALT = 0xaefeb1bc;
/** Grade II +10% / III +15% / IV +20% at level 15. */
const THUNDERWOLF = 0xbe3404b9;
/** "+15% per active pet" — the 15 is literal in the game's own text. */
const PHANTASM = 0x7351d602;
/** Stack-gated; only the value at Cardinal V is quoted. */
const CARDINAL = 0x0151cf9e;
/** A timed buff whose status id this model cannot name. */
const ENCHANTRESS_RHYTHM = 0x30773197;
/** "Boosts DMG Cap by a max of +30%" — basis unstated. */
const ULTRAMARINE = 0x461a8e07;

const sigil = (traitId: number, level: number): Sigil => ({
  firstTraitId: traitId,
  firstTraitLevel: level,
  secondTraitId: 0,
  secondTraitLevel: 0,
  sigilId: 1,
  equippedCharacter: 0,
  sigilLevel: 1,
  acquisitionCount: 0,
  notificationEnum: 0,
});

const loadout = (...traits: [number, number][]): CapLoadout => ({
  sigils: traits.map(([id, level]) => sigil(id, level)),
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
});

/** The one factor for `id`, evaluated under `conditions`. */
const evaluate = (traits: [number, number][], id: number, capClass: "normal" | "skill" | "sba", conditions = {}) => {
  const factor = traitFactors(loadout(...traits), capClass).find((entry) => entry.id === id);
  if (factor === undefined) throw new Error(`no factor for ${id.toString(16)}`);
  return { factor, result: factor.evaluate(conditions) };
};

describe("unconditional trait factors", () => {
  it("declare no params and return their table value", () => {
    const { factor, result } = evaluate([[FATEBREAKER, 15]], FATEBREAKER, "normal");
    expect(factor.params).toEqual([]);
    expect(result).toMatchObject({ percent: 50, potential: 50, state: "active" });
  });

  it("look the value up ONCE at the combined level, not per sigil", () => {
    // Three level-21 sigils are one level-63 trait, which the game shows as
    // "DMG Cap +238%" — not three lookups of level 21.
    const { factor, result } = evaluate(
      [
        [DMG_CAP, 21],
        [DMG_CAP, 21],
        [DMG_CAP, 21],
      ],
      DMG_CAP,
      "normal"
    );
    expect(factor.level).toBe(63);
    expect(result.percent).toBe(238);
  });

  it("are not applicable to a class they do not raise", () => {
    const { result } = evaluate([[UNBOUND_TECHNIQUE, 15]], UNBOUND_TECHNIQUE, "normal");
    expect(result).toMatchObject({ percent: 0, state: "not-applicable", reason: "other-class" });
  });
});

describe("HP-gated trait factors", () => {
  it("Celestial Lumen is unresolved until it is told the HP fraction", () => {
    const { factor, result } = evaluate([[CELESTIAL_LUMEN, 15]], CELESTIAL_LUMEN, "normal");
    expect(factor.params).toEqual(["hpRatio"]);
    // Named and worth +70%, but contributing 0 — counting the maximum would
    // shrink Unaccounted by a number the formula did not necessarily use.
    expect(result).toMatchObject({ percent: 0, potential: 70, state: "unknown", missing: ["hpRatio"] });
  });

  it("Celestial Lumen applies at or above its own 75% gate", () => {
    expect(evaluate([[CELESTIAL_LUMEN, 15]], CELESTIAL_LUMEN, "normal", { hpRatio: 0.8 }).result).toMatchObject({
      percent: 70,
      state: "active",
    });
    expect(evaluate([[CELESTIAL_LUMEN, 15]], CELESTIAL_LUMEN, "normal", { hpRatio: 0.75 }).result).toMatchObject({
      percent: 70,
      state: "active",
    });
  });

  it("Celestial Lumen gives nothing below the gate, but keeps its potential", () => {
    expect(evaluate([[CELESTIAL_LUMEN, 15]], CELESTIAL_LUMEN, "normal", { hpRatio: 0.5 }).result).toMatchObject({
      percent: 0,
      potential: 70,
      state: "inactive",
    });
  });

  it("Celestial Nyx inverts the comparison", () => {
    expect(evaluate([[CELESTIAL_NYX, 15]], CELESTIAL_NYX, "normal", { hpRatio: 0.2 }).result).toMatchObject({
      percent: 120,
      state: "active",
    });
    expect(evaluate([[CELESTIAL_NYX, 15]], CELESTIAL_NYX, "normal", { hpRatio: 0.5 }).result).toMatchObject({
      state: "inactive",
    });
  });

  it("Catastrophe gates on FLAT hp, not a fraction", () => {
    const { factor } = evaluate([[CATASTROPHE, 25]], CATASTROPHE, "normal");
    expect(factor.params).toEqual(["hp"]);
    // 45000 is the level-25 threshold; a 40000 HP character is under it.
    expect(evaluate([[CATASTROPHE, 25]], CATASTROPHE, "normal", { hp: 40000 }).result).toMatchObject({
      percent: 100,
      state: "active",
    });
    expect(evaluate([[CATASTROPHE, 25]], CATASTROPHE, "normal", { hp: 50000 }).result).toMatchObject({
      state: "inactive",
    });
  });
});

describe("banded trait factors", () => {
  it("DMG Cap Cobalt ramps between its own crit-rate bounds", () => {
    const at = (critRate: number) => evaluate([[COBALT, 15]], COBALT, "normal", { critRate }).result;
    // The band is +220% at 100% crit through +270% at 200% crit.
    expect(at(100)).toMatchObject({ percent: 220, state: "active" });
    expect(at(200)).toMatchObject({ percent: 270, state: "active" });
    expect(at(150).percent).toBeCloseTo(245, 6);
    // Past the top of the band it holds, it does not keep climbing.
    expect(at(300)).toMatchObject({ percent: 270, state: "active" });
  });

  it("DMG Cap Cobalt gives nothing below the band", () => {
    expect(evaluate([[COBALT, 15]], COBALT, "normal", { critRate: 50 }).result).toMatchObject({
      percent: 0,
      potential: 270,
      state: "inactive",
    });
  });
});

describe("count-scaled trait factors", () => {
  it("Thunderwolf's Acuity picks the column for the grade that landed", () => {
    const at = (chargeGrade: number) => evaluate([[THUNDERWOLF, 15]], THUNDERWOLF, "normal", { chargeGrade }).result;
    expect(at(2)).toMatchObject({ percent: 10, state: "active" });
    expect(at(3)).toMatchObject({ percent: 15, state: "active" });
    expect(at(4)).toMatchObject({ percent: 20, state: "active" });
    // A shot of no graded charge gets none of it.
    expect(at(1)).toMatchObject({ percent: 0, state: "inactive" });
  });

  it("Phantasm's Harmony multiplies the game's own literal 15% by the pet count", () => {
    const { factor, result } = evaluate([[PHANTASM, 15]], PHANTASM, "normal", { petCount: 2 });
    expect(factor.params).toEqual(["petCount"]);
    expect(result).toMatchObject({ percent: 30, state: "active" });
  });
});

describe("factors this model cannot settle", () => {
  it("Cardinal reports an intermediate stack rather than inventing a curve", () => {
    const key = toHashString(CARDINAL);
    expect(evaluate([[CARDINAL, 15]], CARDINAL, "normal", { stacks: { [key]: 5 } }).result).toMatchObject({
      percent: 310,
      state: "active",
    });
    // Only the value AT V is in the game's text, so 3 stacks has no quoted
    // number — reported as unresolved, not interpolated.
    expect(evaluate([[CARDINAL, 15]], CARDINAL, "normal", { stacks: { [key]: 3 } }).result).toMatchObject({
      state: "unknown",
      reason: "stack-curve-unknown",
    });
    expect(evaluate([[CARDINAL, 15]], CARDINAL, "normal", { stacks: {} }).result).toMatchObject({ state: "inactive" });
  });

  it("a timed buff stays unresolved even when the buff list IS supplied", () => {
    // The caller did its part; this model just cannot name the status id yet.
    const result = evaluate([[ENCHANTRESS_RHYTHM, 15]], ENCHANTRESS_RHYTHM, "normal", { buffs: [1, 2] }).result;
    expect(result).toMatchObject({ state: "unknown", missing: [], reason: "no-status-mapping", potential: 20 });
  });

  it("Ultramarine's Adversity knows its maximum but not what it scales with", () => {
    const result = evaluate([[ULTRAMARINE, 15]], ULTRAMARINE, "normal", {}).result;
    expect(result).toMatchObject({ state: "unknown", reason: "scaling-unknown", potential: 30 });
  });
});
