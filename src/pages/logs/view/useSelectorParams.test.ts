import { describe, expect, it } from "vitest";

import { decodePins, encodePins } from "./useSelectorParams";

describe("selector params", () => {
  it("round-trips a full pin set", () => {
    const pins = { source: 12345, targetIds: [2, 7], ability: "Normal:100" };
    expect(decodePins(encodePins(pins))).toEqual(pins);
  });

  it("round-trips the empty pin set", () => {
    const pins = { source: null, targetIds: [], ability: null };
    expect(decodePins(encodePins(pins))).toEqual(pins);
  });

  it("falls back to All for unparseable values", () => {
    // A hand-edited or stale URL must not break the page.
    expect(decodePins({ src: "abc", tgt: "x,y", abil: "Nonsense:1" })).toEqual({
      source: null,
      targetIds: [],
      ability: null,
    });
  });
});
