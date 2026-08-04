import { describe, expect, it } from "vitest";

import { abilityKey, parseAbilityKey } from "./abilityKey";

describe("abilityKey", () => {
  it("encodes bare variants as their name", () => {
    expect(abilityKey("LinkAttack")).toBe("LinkAttack");
    expect(abilityKey("SBA")).toBe("SBA");
  });

  it("encodes payload variants as name:payload", () => {
    expect(abilityKey({ Normal: 100 })).toBe("Normal:100");
    expect(abilityKey({ SupplementaryDamage: 4000 })).toBe("SupplementaryDamage:4000");
    expect(abilityKey({ Group: "genji" })).toBe("Group:genji");
  });

  it("round-trips every shape", () => {
    for (const action of [
      "LinkAttack",
      "PerfectGuard",
      { Normal: 100 },
      { DamageOverTime: 2 },
      { Group: "genji" },
    ] as const) {
      expect(parseAbilityKey(abilityKey(action))).toEqual(action);
    }
  });

  it("returns null for a key it does not recognise", () => {
    // A stale URL must not crash the page — it falls back to "All".
    expect(parseAbilityKey("Nonsense:1")).toBeNull();
    expect(parseAbilityKey("")).toBeNull();
  });
});
