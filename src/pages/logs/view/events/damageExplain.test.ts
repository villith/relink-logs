import { describe, expect, it } from "vitest";

import type { LogEvent } from "@/types";

import statusClasses from "../../../../../src-tauri/assets/status-classes.json";

import type { ExplainHit } from "./capExplain";
import type { CapConditions } from "./capFactors";
import { amplifyStatusIds, explainDamageHit, type DamageExplainInput, type DamageTraitTable } from "./damageExplain";
import { blob } from "./damageSnapshot.test";
import { f32Bytes, blob as recordBlob } from "./recordSnapshot.test";

/** A blob that PROVES the builder ran: nonzero `+0xD0` (d0). */
const populatedBlob = (entries: Array<[number, number[]]>): number[] => blob([[0xd0, [0xe8, 0x03, 0, 0]], ...entries]); // d0 = 1000

/** A blob shaped like a remote player's hit: gate bytes present but `+0xD0`
 * and `+0x2D4` both zero, so it must read as unpopulated. */
const unpopulatedBlob = (entries: Array<[number, number[]]>): number[] => blob(entries);

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
    // SKILL_099_00 (crit section, gate-byte trait — back attack byte+0x15F).
    "4b400b01": { key: "SKILL_099_00", name: "SKILL_099_00", values: { value: [7] } },
    // Overdrive Assassin (gate-byte trait, window-inferable when unmeasured).
    a9d17f55: { key: "SKILL_331_00", name: "Overdrive Assassin", values: { value: [12] } },
    // Break Assassin (gate-byte trait, window-inferable when unmeasured).
    ac9674c1: { key: "SKILL_332_00", name: "Break Assassin", values: { value: [9] } },
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
    { sigilId: 6, firstTraitId: 0xc35b111b, firstTraitLevel: 1, secondTraitId: 0x4b400b01, secondTraitLevel: 1 },
    { sigilId: 7, firstTraitId: 0xa9d17f55, firstTraitLevel: 1, secondTraitId: 0xac9674c1, secondTraitLevel: 1 },
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
  instance_snapshot: null,
  record_snapshot: null,
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

/** Like `line`, but for the tests that need to set `modeInference` — a
 * full `DamageExplainInput` override rather than just the hit fields. */
const lineWithInput = (sectionKey: string, lineKey: string, input: Partial<DamageExplainInput> = {}) => {
  const explained = explainDamageHit({ hit: HIT, loadout: LOADOUT, conditions: {}, ...input }, TABLE);
  const found = explained.find((s) => s.key === sectionKey)?.lines.find((l) => l.key === lineKey);
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

describe("gate-byte trait: measured verdict from a recorded snapshot", () => {
  // 6b694d6d's weakpoint slot gates on inst+0x15E (GateBytes.weakPoint).
  it("reads a real yes verdict from a builder-populated snapshot", () => {
    const weak = line("dmg-chain", "trait-6b694d6d-weakpoint", {
      instance_snapshot: populatedBlob([[0x15e, [1]]]),
    });
    expect(weak.excluded).toBeUndefined();
    expect(weak.value).toEqual({ kind: "percent", value: 15 });
    expect(weak.source).toEqual({ kind: "literal", value: "SKILL_020_00 L1 [weakpoint], inst+0x15E" });
  });

  it("reads a real no verdict as conditional, value still shown", () => {
    const weak = line("dmg-chain", "trait-6b694d6d-weakpoint", {
      instance_snapshot: populatedBlob([[0x15e, [0]]]),
    });
    expect(weak.excluded).toBe("conditional");
    expect(weak.value).toEqual({ kind: "percent", value: 15 });
    expect(weak.source).toEqual({ kind: "literal", value: "SKILL_020_00 L1 [weakpoint], inst+0x15E" });
  });

  it("falls back to gate-unrecorded for an unpopulated (remote-style) snapshot", () => {
    // Gate byte set, but +0xD0/+0x2D4 both zero — the log-405 remote
    // signature. Its bytes may mean "not computed here", not "no".
    const weak = line("dmg-chain", "trait-6b694d6d-weakpoint", {
      instance_snapshot: unpopulatedBlob([[0x15e, [1]]]),
    });
    expect(weak.excluded).toBe("gate-unrecorded");
    expect(weak.value).toEqual({ kind: "percent", value: 15 });
    expect(weak.source).toEqual({ kind: "literal", value: "SKILL_020_00 L1 [weakpoint]" });
  });

  it("falls back to gate-unrecorded when no snapshot was captured at all", () => {
    const weak = line("dmg-chain", "trait-6b694d6d-weakpoint", { instance_snapshot: null });
    expect(weak.excluded).toBe("gate-unrecorded");
    expect(weak.value).toEqual({ kind: "percent", value: 15 });
  });
});

describe("gate-byte trait: window-inferred verdict for the two mode traits", () => {
  it("infers a yes verdict from the mode windows when unmeasured, marked as inferred", () => {
    const od = lineWithInput("dmg-chain", "trait-a9d17f55-value", {
      hit: HIT,
      modeInference: { overdrive: true, break: false },
    });
    expect(od.excluded).toBeUndefined();
    expect(od.inferred).toBe(true);
    expect(od.value).toEqual({ kind: "percent", value: 12 });
    expect(od.source).toEqual({ kind: "literal", value: "SKILL_331_00 L1, mode windows" });
  });

  it("infers a no verdict as conditional when unmeasured, marked as inferred", () => {
    const brk = lineWithInput("dmg-chain", "trait-ac9674c1-value", {
      hit: HIT,
      modeInference: { overdrive: true, break: false },
    });
    expect(brk.excluded).toBe("conditional");
    expect(brk.inferred).toBe(true);
    expect(brk.value).toEqual({ kind: "percent", value: 9 });
    expect(brk.source).toEqual({ kind: "literal", value: "SKILL_332_00 L1, mode windows" });
  });

  it("a measured verdict always wins over window inference", () => {
    const od = lineWithInput("dmg-chain", "trait-a9d17f55-value", {
      hit: { ...HIT, instance_snapshot: populatedBlob([[0x162, [0]]]) }, // measured: overdrive NO
      modeInference: { overdrive: true, break: false }, // inference says YES
    });
    expect(od.inferred).toBeUndefined();
    expect(od.excluded).toBe("conditional");
    expect(od.source).toEqual({ kind: "literal", value: "SKILL_331_00 L1, inst+0x162" });
  });

  it("falls back to gate-unrecorded, not inferred, when no mode windows exist at all", () => {
    const od = lineWithInput("dmg-chain", "trait-a9d17f55-value", { hit: HIT, modeInference: null });
    expect(od.excluded).toBe("gate-unrecorded");
    expect(od.inferred).toBeUndefined();
  });

  it("falls back to gate-unrecorded when modeInference is not supplied at all", () => {
    const od = lineWithInput("dmg-chain", "trait-a9d17f55-value", { hit: HIT });
    expect(od.excluded).toBe("gate-unrecorded");
    expect(od.inferred).toBeUndefined();
  });

  it("leaves an unrelated gate-byte trait (weak point) untouched by mode inference", () => {
    const weak = lineWithInput("dmg-chain", "trait-6b694d6d-weakpoint", {
      hit: HIT,
      modeInference: { overdrive: true, break: true },
    });
    expect(weak.excluded).toBe("gate-unrecorded");
    expect(weak.inferred).toBeUndefined();
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

  it("still shows the threshold-bearing source when only the hp ratio is missing", () => {
    // The threshold is a fact about the table, not about this hit — it should
    // read regardless of whether hpRatio was captured for this hit.
    const gated = line("dmg-chain", "trait-a7726190-value");
    expect(gated.excluded).toBe("gate-unrecorded");
    expect(gated.source).toEqual({ kind: "literal", value: "SKILL_321_00 L1, hp gte 75%" });
  });

  it("falls back to the default source when the table has no threshold row", () => {
    // Celestial Nyx's fake table row omits hpGate — with no threshold to show,
    // the generic `L<n>` source is what's left.
    const gated = line("dmg-chain", "trait-0de887a0-value", {}, { hpRatio: 0.1 });
    expect(gated.excluded).toBe("gate-unrecorded");
    expect(gated.source).toEqual({ kind: "literal", value: "SKILL_320_00 L1" });
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
  it("shows the roll as unrecorded when no snapshot was captured", () => {
    const roll = line("dmg-crit", "crit-roll");
    expect(roll.excluded).toBe("gate-unrecorded");
    expect(roll.value).toEqual({ kind: "absent" });
  });

  it("reads a real crit-yes verdict from a builder-populated snapshot", () => {
    const roll = line("dmg-crit", "crit-roll", { instance_snapshot: populatedBlob([[0x15d, [1]]]) });
    expect(roll.excluded).toBeUndefined();
    expect(roll.value).toEqual({ kind: "verdict", value: true });
  });

  it("reads a real crit-no verdict from a builder-populated snapshot, not excluded", () => {
    const roll = line("dmg-crit", "crit-roll", { instance_snapshot: populatedBlob([[0x15d, [0]]]) });
    expect(roll.excluded).toBeUndefined();
    expect(roll.value).toEqual({ kind: "verdict", value: false });
  });

  it("falls back to unrecorded for an unpopulated (remote-style) snapshot", () => {
    const roll = line("dmg-crit", "crit-roll", { instance_snapshot: unpopulatedBlob([[0x15d, [1]]]) });
    expect(roll.excluded).toBe("gate-unrecorded");
    expect(roll.value).toEqual({ kind: "absent" });
  });

  // SKILL_099_00 (4b400b01) is a crit-section trait but gates on the SAME
  // byte as weak-point's back-attack slot (+0x15F), not on the crit byte.
  it("reads the crit-section back-attack trait from byte+0x15F, not the crit byte", () => {
    const backAttack = line("dmg-crit", "trait-4b400b01-value", {
      instance_snapshot: populatedBlob([
        [0x15d, [0]], // crit: no
        [0x15f, [1]], // back attack: yes
      ]),
    });
    expect(backAttack.excluded).toBeUndefined();
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

  it("values the record dmg% line from the record snapshot, Skill vs SBA", () => {
    // HIT.class_flags is 0x10000 (Skill).
    const skill = line("dmg-class", "record", { record_snapshot: recordBlob([[0x24, f32Bytes(15)]]) });
    expect(skill.value).toEqual({ kind: "percent", value: 15 });
    expect(skill.excluded).toBeUndefined();

    const sba = line("dmg-class", "record", {
      class_flags: 0x40000,
      record_snapshot: recordBlob([[0x1c, f32Bytes(7.5)]]),
    });
    expect(sba.value).toEqual({ kind: "percent", value: 7.5 });
    expect(sba.excluded).toBeUndefined();
  });

  it("excludes the record dmg% line as value-unrecorded when no snapshot was captured", () => {
    expect(line("dmg-class", "record", { record_snapshot: null }).excluded).toBe("value-unrecorded");
  });

  it("excludes the record dmg% line as other-class for Normal hits, even with a snapshot", () => {
    const normal = line("dmg-class", "record", {
      class_flags: 0,
      record_snapshot: recordBlob([[0x24, f32Bytes(15)]]),
    });
    expect(normal.excluded).toBe("other-class");
    expect(normal.value).toEqual({ kind: "absent" });
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

describe("postcap section", () => {
  it("substitutes the observed ratio final / min(base, cap)", () => {
    // 1,470,000 / 1,000,000 = 1.470 (toFixed(3) of the multiplier)
    expect(section("dmg-postcap").substituted).toContain("x1.470");
  });

  it("renders the overflow row only on capped hits", () => {
    expect(section("dmg-postcap").lines.some((l) => l.key === "overflow")).toBe(true);
    expect(section("dmg-postcap", { base_damage: 900_000 }).lines.some((l) => l.key === "overflow")).toBe(false);
  });

  it("degrades the ratio to absent and the section to unsubstituted when base_damage is unrecorded", () => {
    const sec = section("dmg-postcap", { base_damage: null });
    expect(sec.substituted).toBeNull();
    const ratioLine = sec.lines.find((l) => l.key === "ratio")!;
    expect(ratioLine.value).toEqual({ kind: "absent" });
  });

  it("lists held amplify statuses by id", () => {
    const out = explainDamageHit(
      {
        hit: HIT,
        loadout: LOADOUT,
        conditions: { buffs: [111, 222], stacks: { "111": 1, "222": 3 } },
        amplifyStatusIds: new Set([222]),
      },
      TABLE
    );
    const postcap = out.find((s) => s.key === "dmg-postcap")!;
    const held = postcap.lines.filter((l) => l.key.startsWith("amplify-status-"));
    expect(held).toHaveLength(1);
    expect(held[0].key).toBe("amplify-status-222");
    // The full rendered text, not just the key — id and stack count both matter.
    expect(held[0].value).toEqual({ kind: "text", value: "#222 x3" });
  });

  it("falls back to x1 for a held amplify status with no stacks entry", () => {
    // buffs carries the id but `conditions.stacks` never mentions it — the
    // `?? 1` fallback in postcapSection, exercised directly.
    const out = explainDamageHit(
      { hit: HIT, loadout: LOADOUT, conditions: { buffs: [222] }, amplifyStatusIds: new Set([222]) },
      TABLE
    );
    const postcap = out.find((s) => s.key === "dmg-postcap")!;
    const held = postcap.lines.find((l) => l.key === "amplify-status-222")!;
    expect(held.value).toEqual({ kind: "text", value: "#222 x1" });
  });
});

describe("amplifyStatusIds", () => {
  it("collects status ids whose applied class name contains Amplify", () => {
    const classTable = {
      "12345": { class: "StatusAmplifyDamageBuff", name: "Amp" },
      "9": { class: "StatusAtkUp", name: "Atk" },
    };
    const events = [
      [
        0,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 222,
            ability_id: null,
            stacks: 1,
            status_class: 12345,
            caster_action_id: null,
          },
        },
      ],
      [
        1,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 333,
            ability_id: null,
            stacks: 1,
            status_class: 9,
            caster_action_id: null,
          },
        },
      ],
      [
        2,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 444,
            ability_id: null,
            stacks: 1,
            status_class: null,
            caster_action_id: null,
          },
        },
      ],
    ] as unknown as LogEvent[];
    expect([...amplifyStatusIds(events, classTable)]).toEqual([222]);
  });
});

describe("amplifyStatusIds against the real shipped table", () => {
  // The "Amplify" substring matches exactly two classes in the shipped
  // status-classes.json today: StatusAmplifyDamageBuff and
  // StatusAmplifyDamageDebuff — the signed + and - halves of the post-cap
  // chain's ΣIStatusAmplifyBuff ± walk, not a spurious debuff match. If a
  // game-update regen of the asset ever adds a THIRD class whose RTTI name
  // happens to contain "Amplify", this count assertion is what turns that
  // silent net-widening into a failing test instead of an unnoticed change
  // in what the post-cap section reports as held.
  it("matches exactly the two signed Amplify classes", () => {
    const matches = Object.values(statusClasses as Record<string, { class: string; name: string }>).filter((entry) =>
      /Amplify/.test(entry.class)
    );
    expect(matches.map((m) => m.class).sort()).toEqual(["StatusAmplifyDamageBuff", "StatusAmplifyDamageDebuff"]);
  });

  it("collects both real Amplify class hashes and excludes an unrelated real class", () => {
    // 2697949828 = StatusAmplifyDamageBuff, 2952924837 = StatusAmplifyDamageDebuff,
    // 208567 = StatusPl0900UniqueBuffCount (a real, known non-amplify class).
    const events = [
      [
        0,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 111,
            ability_id: null,
            stacks: 1,
            status_class: 2697949828,
            caster_action_id: null,
          },
        },
      ],
      [
        1,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 222,
            ability_id: null,
            stacks: 1,
            status_class: 2952924837,
            caster_action_id: null,
          },
        },
      ],
      [
        2,
        {
          StatusApply: {
            actor_index: 0,
            caster_index: null,
            status_id: 333,
            ability_id: null,
            stacks: 1,
            status_class: 208567,
            caster_action_id: null,
          },
        },
      ],
    ] as unknown as LogEvent[];
    // No second arg: exercises the real default table amplifyStatusIds reads.
    expect([...amplifyStatusIds(events)]).toEqual([111, 222]);
  });
});
