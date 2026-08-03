import { describe, expect, it } from "vitest";

import { BAND_BASE_OPACITY, BAND_MAX_OPACITY, bandOpacity, toBands } from "./statusBands";

const WINDOW = { startMs: 0, endMs: 10_000 };

describe("toBands", () => {
  it("converts intervals into window-relative spans", () => {
    expect(toBands([{ startMs: 2_000, endMs: 4_000 }], WINDOW)).toEqual([{ startMs: 2_000, endMs: 4_000, stacks: 1 }]);
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
    expect(toBands([{ startMs: 8_000, endMs: 99_000 }], WINDOW)).toEqual([
      { startMs: 8_000, endMs: 10_000, stacks: 1 },
    ]);
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

  it("carries the peak stacks of every window it merged", () => {
    // The band spans every holder and every refresh, so the one number it can
    // honestly report is the highest the effect ever reached inside it.
    expect(
      toBands(
        [
          { startMs: 0, endMs: 5_000, maxStacks: 2 },
          { startMs: 4_000, endMs: 8_000, maxStacks: 5 },
        ],
        WINDOW
      )
    ).toEqual([{ startMs: 0, endMs: 8_000, stacks: 5 }]);
  });

  it("keeps separate spans on their own stack counts", () => {
    expect(
      toBands(
        [
          { startMs: 0, endMs: 2_000, maxStacks: 3 },
          { startMs: 6_000, endMs: 8_000, maxStacks: 1 },
        ],
        WINDOW
      )
    ).toEqual([
      { startMs: 0, endMs: 2_000, stacks: 3 },
      { startMs: 6_000, endMs: 8_000, stacks: 1 },
    ]);
  });

  it("treats a window with no stack count as one stack", () => {
    // Most statuses are not stackable at all, and the hook reports 1 for them.
    expect(toBands([{ startMs: 0, endMs: 2_000 }], WINDOW)).toEqual([{ startMs: 0, endMs: 2_000, stacks: 1 }]);
  });
});

describe("bandOpacity", () => {
  it("shades a single stack exactly as an unstackable status", () => {
    // Most statuses never stack, so one stack must look like the shading the
    // chart has always drawn rather than becoming a new, fainter thing.
    expect(bandOpacity(1)).toBe(BAND_BASE_OPACITY);
  });

  it("shades a deeper stack more strongly", () => {
    expect(bandOpacity(3)).toBeGreaterThan(bandOpacity(1));
    expect(bandOpacity(6)).toBeGreaterThan(bandOpacity(3));
  });

  it("stops before the band can hide the plot under it", () => {
    // The band is a backdrop for the DPS lines; past this it reads as a fill.
    expect(bandOpacity(500)).toBe(BAND_MAX_OPACITY);
  });

  it("treats a missing or nonsense count as one stack", () => {
    expect(bandOpacity(0)).toBe(BAND_BASE_OPACITY);
    expect(bandOpacity(-3)).toBe(BAND_BASE_OPACITY);
  });
});
