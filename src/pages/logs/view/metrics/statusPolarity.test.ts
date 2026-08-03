import { describe, expect, it } from "vitest";

import { HARMFUL_STATUS_IDS, isHarmful } from "./statusPolarity";

describe("status polarity", () => {
  it("marks the game's own negative statuses harmful", () => {
    // atkdown (2) and defdown (3) are the low-id debuffs the old holder-based
    // split misfiled; burn (1001) is an ailment.
    expect(isHarmful(2)).toBe(true);
    expect(isHarmful(3)).toBe(true);
    expect(isHarmful(1001)).toBe(true);
  });

  it("marks buffs beneficial, including ones enemies give themselves", () => {
    // atkup (0) is the most common buff; bloodthirst (32) is an ENEMY
    // self-buff — the exact row the Debuffs tab used to misfile.
    expect(isHarmful(0)).toBe(false);
    expect(isHarmful(32)).toBe(false);
  });

  it("treats an id the table has never seen as beneficial", () => {
    // A future patch's new ailment will misfile until regeneration, but a
    // thrown-away row would be worse — beneficial is the documented fallback.
    expect(isHarmful(999_999)).toBe(false);
  });

  it("covers the whole 1000+ ailment family", () => {
    expect([...HARMFUL_STATUS_IDS].filter((id) => id >= 1000)).toHaveLength(22);
  });
});
