import { describe, expect, it } from "vitest";

import type { ExplainHit } from "./capExplain";
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
  },
};

/** Loadout with Skilled Assault L2 (sigil) + Charged Attack DMG L1 + Weak Point L1. */
const LOADOUT = {
  sigils: [
    { sigilId: 1, firstTraitId: 0xeae321eb, firstTraitLevel: 2, secondTraitId: 0, secondTraitLevel: 0 },
    { sigilId: 2, firstTraitId: 0x1c360c63, firstTraitLevel: 1, secondTraitId: 0x6b694d6d, secondTraitLevel: 1 },
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

const sections = (over: Partial<typeof HIT> = {}) =>
  explainDamageHit({ hit: { ...HIT, ...over }, loadout: LOADOUT, conditions: {} }, TABLE);

const section = (key: string, over: Partial<typeof HIT> = {}) => {
  const found = sections(over).find((s) => s.key === key);
  expect(found).toBeDefined();
  return found!;
};

const line = (sectionKey: string, lineKey: string, over: Partial<typeof HIT> = {}) => {
  const found = section(sectionKey, over).lines.find((l) => l.key === lineKey);
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
