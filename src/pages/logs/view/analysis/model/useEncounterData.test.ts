import { describe, expect, it } from "vitest";

import { needsScopedFetch, type ScopeReasons } from "./useEncounterData";

const NONE: ScopeReasons = {
  pinned: false,
  isWindowed: false,
  hasMask: false,
  wantsBands: false,
  needsGroups: false,
};

describe("needsScopedFetch", () => {
  it("skips the fetch when nothing narrows the fight", () => {
    // The base load already answers this exact question, and repeating it
    // would cost a decompress-and-reparse for no new information.
    expect(needsScopedFetch(NONE)).toBe(false);
  });

  it("fetches for any one reason on its own", () => {
    const reasons = ["pinned", "isWindowed", "hasMask", "wantsBands", "needsGroups"] as const;
    for (const reason of reasons) {
      expect(needsScopedFetch({ ...NONE, [reason]: true }), reason).toBe(true);
    }
  });

  it("fetches when several reasons hold at once", () => {
    expect(needsScopedFetch({ ...NONE, pinned: true, isWindowed: true, hasMask: true })).toBe(true);
  });

  it("treats a regroup with nothing pinned as a real request", () => {
    // `wantsBands` is stun's party-wide ability level: no pin, no window, no
    // mask, but the bands still have to come from somewhere. None of the other
    // clauses can see it, which is why it is its own reason.
    expect(needsScopedFetch({ ...NONE, wantsBands: true })).toBe(true);
  });
});
