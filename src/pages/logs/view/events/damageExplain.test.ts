import { describe, expect, it } from "vitest";

import type { ExplainHit } from "./capExplain";
import type { CapConditions } from "./capFactors";
import { explainDamageHit, type DamageTraitTable } from "./damageExplain";

/** A tiny fake value table so tests never depend on the generated asset. */
const TABLE: DamageTraitTable = {
  version: "test",
  traits: {
    // Skilled Assault: +25% at L2.
    eae321eb: { key: "SKILL_103_00", name: "Skilled Assault", values: { value: [20, 25] } },
    // Charged Attack DMG.
    "1c360c63": { key: "SKILL_004_00", name: "Charged Attack DMG", values: { value: [10, 12] } },
    // Weak Point DMG (gate-byte trait).
    "6b694d6d": { key: "SKILL_020_00", name: "Weak Point DMG", values: { weakpoint: [15], backattack: [8] } },
    // Concentrated Fire (flags-bit trait, bit 0x8).
    b360801d: { key: "SKILL_018_00", name: "Concentrated Fire", values: { value: [10] } },
    // Celestial Lumen (hp-gate trait, gte 75%).
    a7726190: { key: "SKILL_321_00", name: "Celestial Lumen", values: { value: [30], hpGate: [75] } },
    // Celestial Nyx (hp-gate trait, lte 25% in the real tables) — this fake
    // row omits `hpGate` on purpose, to cover the missing-threshold-row case.
    "0de887a0": { key: "SKILL_320_00", name: "Celestial Nyx", values: { value: [16] } },
    // Lucky Charge (crit section, class-flag bit 0x2 — charged attack).
    c35b111b: { key: "SKILL_030_00", name: "Lucky Charge", values: { value: [5] } },
  },
};

/**
 * Loadout exercising every gate kind the registry covers:
 *  - Skilled Assault L2, split across TWO sigils at L1 each — only summing
 *    through `computeCombinedTraits` reaches L2 (and thus the table's +25%
 *    row); reading either sigil's own field would stop at L1's +20%.
 *  - Charged Attack DMG L1 + Weak Point L1 (class-flag / gate-byte, existing coverage).
 *  - Concentrated Fire L1 (flags-bit) + Celestial Lumen L1 (hp-gate, gte).
 *  - Celestial Nyx L1 (hp-gate, lte) — table row has no `hpGate` slot.
 */
const LOADOUT = {
  sigils: [
    { sigilId: 1, firstTraitId: 0xeae321eb, firstTraitLevel: 1, secondTraitId: 0, secondTraitLevel: 0 },
    { sigilId: 2, firstTraitId: 0xeae321eb, firstTraitLevel: 1, secondTraitId: 0, secondTraitLevel: 0 },
    { sigilId: 3, firstTraitId: 0x1c360c63, firstTraitLevel: 1, secondTraitId: 0x6b694d6d, secondTraitLevel: 1 },
    { sigilId: 4, firstTraitId: 0xb360801d, firstTraitLevel: 1, secondTraitId: 0xa7726190, secondTraitLevel: 1 },
    { sigilId: 5, firstTraitId: 0x0de887a0, firstTraitLevel: 1, secondTraitId: 0, secondTraitLevel: 0 },
    { sigilId: 6, firstTraitId: 0xc35b111b, firstTraitLevel: 1, secondTraitId: 0, secondTraitLevel: 0 },
  ],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
} as never;

const HIT: ExplainHit = {
  damage: 1_470_000,
  base_damage: 1_200_000,
  damage_cap: 1_000_000,
  attack_rate: 3.2,
  class_flags: 0x10000, // Skill
  flags: 0,
};

const sections = (over: Partial<typeof HIT> = {}, conditions: CapConditions = {}) =>
  explainDamageHit({ hit: { ...HIT, ...over }, loadout: LOADOUT, conditions }, TABLE);

const section = (key: string, over: Partial<typeof HIT> = {}, conditions: CapConditions = {}) => {
  const found = sections(over, conditions).find((s) => s.key === key);
  expect(found).toBeDefined();
  return found!;
};

const line = (sectionKey: string, lineKey: string, over: Partial<typeof HIT> = {}, conditions: CapConditions = {}) => {
  const found = section(sectionKey, over, conditions).lines.find((l) => l.key === lineKey);
  expect(found).toBeDefined();
  return found!;
};

describe("hit section", () => {
  it("reports the capped verdict from base vs cap", () => {
    expect(line("dmg-hit", "capped").value).toEqual({ kind: "verdict", value: true });
    expect(line("dmg-hit", "capped", { base_damage: 900_000 }).value).toEqual({ kind: "verdict", value: false });
  });

  it("degrades to absent on an old log, never to zero", () => {
    expect(line("dmg-hit", "capped", { base_damage: null }).value).toEqual({ kind: "absent" });
  });
});

describe("attack chain", () => {
  it("values an equipped trait at its combined level when its class gate fires", () => {
    // eae321eb is split L1 + L1 across two sigils; only the combined L2 row
    // (+25%) is right — a bug reading a single sigil's slot would give +20%.
    const skilled = line("dmg-chain", "trait-eae321eb-value");
    expect(skilled.excluded).toBeUndefined();
    expect(skilled.value).toEqual({ kind: "percent", value: 25 });
  });

  it("excludes a trait whose class gate did not fire", () => {
    // class_flags 0x10000 is not a charged attack (bit 0x2).
    expect(line("dmg-chain", "trait-1c360c63-value").excluded).toBe("conditional");
  });

  it("marks gate-byte traits as gate-unrecorded, value still shown", () => {
    const weak = line("dmg-chain", "trait-6b694d6d-weakpoint");
    expect(weak.excluded).toBe("gate-unrecorded");
    expect(weak.value).toEqual({ kind: "percent", value: 15 });
  });

  it("marks class gates unresolvable when class_flags is null", () => {
    expect(line("dmg-chain", "trait-eae321eb-value", { class_flags: null }).excluded).toBe("gate-unrecorded");
  });
});

describe("flags-bit gate", () => {
  it("includes the trait when its flags bit is set", () => {
    const included = line("dmg-chain", "trait-b360801d-value", { flags: 0x8 });
    expect(included.excluded).toBeUndefined();
    expect(included.value).toEqual({ kind: "percent", value: 10 });
  });

  it("excludes the trait as conditional when the flags bit is clear", () => {
    expect(line("dmg-chain", "trait-b360801d-value", { flags: 0 }).excluded).toBe("conditional");
  });
});

describe("hp-gate gate", () => {
  it("is gate-unrecorded when the hp ratio is not known", () => {
    expect(line("dmg-chain", "trait-a7726190-value").excluded).toBe("gate-unrecorded");
  });

  it("applies when the hp ratio clears the gate", () => {
    const gated = line("dmg-chain", "trait-a7726190-value", {}, { hpRatio: 0.8 });
    expect(gated.excluded).toBeUndefined();
    expect(gated.value).toEqual({ kind: "percent", value: 30 });
  });

  it("excludes as conditional when the hp ratio misses the gate", () => {
    expect(line("dmg-chain", "trait-a7726190-value", {}, { hpRatio: 0.5 }).excluded).toBe("conditional");
  });

  it("is gate-unrecorded when the table carries no hpGate row for the trait", () => {
    // Celestial Nyx's fake table row omits hpGate on purpose — even a known
    // hp ratio cannot resolve a gate with no threshold to compare against.
    expect(line("dmg-chain", "trait-0de887a0-value", {}, { hpRatio: 0.1 }).excluded).toBe("gate-unrecorded");
  });
});

describe("crit section", () => {
  it("always shows the roll as unrecorded", () => {
    const roll = line("dmg-crit", "crit-roll");
    expect(roll.excluded).toBe("gate-unrecorded");
    expect(roll.value).toEqual({ kind: "absent" });
  });

  it("includes a crit trait when its class gate fires", () => {
    // c35b111b (Lucky Charge) gates on bit 0x2 (charged attack); default
    // HIT.class_flags is 0x10000 (Skill) with bit 0x2 clear.
    const included = line("dmg-crit", "trait-c35b111b-value", { class_flags: 0x10000 | 0x2 });
    expect(included.excluded).toBeUndefined();
    expect(included.value).toEqual({ kind: "percent", value: 5 });
  });

  it("excludes the crit trait as conditional when its class gate does not fire", () => {
    expect(line("dmg-crit", "trait-c35b111b-value").excluded).toBe("conditional");
  });
});

describe("class section", () => {
  it("names the attack class from class_flags", () => {
    expect(line("dmg-class", "attack-class").value).toEqual({ kind: "text", value: "skill" });
    expect(line("dmg-class", "attack-class", { class_flags: 0x40000 }).value).toEqual({
      kind: "text",
      value: "sba",
    });
    expect(line("dmg-class", "attack-class", { class_flags: null }).value).toEqual({ kind: "absent" });
  });
});

describe("taken/variance section", () => {
  it("states the one-sided variance band on the precap", () => {
    const sec = section("dmg-taken");
    expect(sec.formula).toContain("1.05");
    expect(line("dmg-taken", "variance-band").value.kind).toBe("text");
  });

  it("pins the band endpoint to floor(base/1.05), never excluding the true d4", () => {
    // 1000 / 1.05 is deliberately fractional (~952.38) so floor and ceil land
    // on different integers and cannot alias — floor(952.38) = 952,
    // ceil(952.38) = 953. A ceil regression here would show up as "953".
    const lower = Math.floor(1000 / 1.05).toLocaleString();
    const upper = (1000).toLocaleString();
    expect(section("dmg-taken", { base_damage: 1000 }).substituted).toBe(`d4 in (${lower} .. ${upper}]`);
    expect(line("dmg-taken", "variance-band", { base_damage: 1000 }).value).toEqual({
      kind: "text",
      value: `${lower} .. ${upper}`,
    });
  });

  it("degrades to absent on an old log, never to zero", () => {
    expect(section("dmg-taken", { base_damage: null }).substituted).toBeNull();
    expect(line("dmg-taken", "variance-band", { base_damage: null }).value).toEqual({ kind: "absent" });
  });
});
