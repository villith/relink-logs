import { describe, expect, it } from "vitest";

import { gameXxhash32 } from "./gbfr-hash.mjs";

/** Vectors taken from the shipped data, cross-checked against the Python port in
 * scripts/gbfr_hash.py: a summon body class is XXHash32Custom("So####"), and an
 * enemy type id is XXHash32Custom of its Capitalized id. */
describe("gameXxhash32", () => {
  it("reproduces summon body class hashes", () => {
    // d2e5407a and 5395ce93 are the two classes src/summonSkillName.test.ts uses.
    expect(gameXxhash32("So0000")).toBe("d2e5407a");
    expect(gameXxhash32("So9200")).toBe("5395ce93");
    expect(gameXxhash32("So3f00")).toBe("c3e77085");
    expect(gameXxhash32("So0d00")).toBe("69893920");
  });

  it("reproduces enemy type hashes", () => {
    // All three are literally keys in src-tauri/lang/en/enemies.json, so this
    // ties the port to shipped data rather than to the Python port alone.
    expect(gameXxhash32("Ba0350")).toBe("c9795190");
    expect(gameXxhash32("Em2400")).toBe("b39eeab5");
    expect(gameXxhash32("Em0003")).toBe("00012bcd");
  });

  it("takes the >= 16 byte branch for a long input", () => {
    // Every id this script hashes is 6 chars, so the long branch is otherwise
    // untested — and it is where the custom port differs from stock XXHash32
    // (hardcoded lane seeds and a `> 16`-not-`>= 16` loop exit).
    expect(gameXxhash32("TXT_SB_EXPL_PL0000_SP000")).toBe("1b3c5eee");
  });

  it("handles an input shorter than one 4-byte lane", () => {
    expect(gameXxhash32("A")).toBe("2a16e71e");
  });

  it("always returns eight lowercase hex digits", () => {
    for (const id of ["So0000", "So0d00", "Em0003", "A"]) {
      expect(gameXxhash32(id)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
