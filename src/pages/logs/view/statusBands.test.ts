import { describe, expect, it } from "vitest";

import { toBands } from "./statusBands";

const WINDOW = { startMs: 0, endMs: 10_000 };

describe("toBands", () => {
  it("converts intervals into window-relative spans", () => {
    expect(toBands([{ startMs: 2_000, endMs: 4_000 }], WINDOW)).toEqual([{ startMs: 2_000, endMs: 4_000 }]);
  });

  it("rebases a span onto a scrubbed window", () => {
    // The chart IS the window — its first bucket is the window's start — so a
    // band drawn at absolute time would sit wherever the scrub began.
    expect(toBands([{ startMs: 5_000, endMs: 7_000 }], { startMs: 4_000, endMs: 10_000 })).toEqual([
      { startMs: 1_000, endMs: 3_000, stacks: 1 },
    ]);
  });

  it("clamps a band that overruns the window", () => {
    // An unclosed interval ends at the fight end, but a scrub window can be
    // shorter than the interval at either edge.
    expect(toBands([{ startMs: 8_000, endMs: 99_000 }], WINDOW)).toEqual([{ startMs: 8_000, endMs: 10_000 }]);
  });

  it("drops a band entirely outside the window", () => {
    expect(toBands([{ startMs: 20_000, endMs: 30_000 }], WINDOW)).toEqual([]);
  });

  it("drops a band that meets the window only at its edge", () => {
    // Zero width: it would draw as a hairline over a moment it never covered.
    expect(toBands([{ startMs: 10_000, endMs: 12_000 }], WINDOW)).toEqual([]);
  });

  it("returns nothing for a zero-length window", () => {
    // Guards the empty log, where every band would be zero width anyway.
    expect(toBands([{ startMs: 0, endMs: 1_000 }], { startMs: 0, endMs: 0 })).toEqual([]);
  });
});
