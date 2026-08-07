import { describe, expect, it } from "vitest";

import { wireWindowsFrom } from "./wireWindows";

// Both producers feed this: status intervals (the aura filter) and battle
// windows (the window filter). The cases below are the union of what the two
// used to assert separately, kept together now that one function answers for
// both — an edge rule that changes has to change for both at once.
const span = (startMs: number, endMs: number) => ({ startMs, endMs });

describe("wireWindowsFrom", () => {
  const WINDOW = { startMs: 1_000, endMs: 10_000 };

  it("clips to the window and merges overlaps, in fight-relative ms", () => {
    expect(wireWindowsFrom([span(0, 3_000), span(2_000, 5_000), span(8_000, 12_000)], WINDOW)).toEqual([
      { fromMs: 1_000, upToMs: 5_000 },
      { fromMs: 8_000, upToMs: 10_000 },
    ]);
  });

  it("answers empty when nothing was up inside the window", () => {
    expect(wireWindowsFrom([span(20_000, 30_000)], WINDOW)).toEqual([]);
    expect(wireWindowsFrom([], WINDOW)).toEqual([]);
  });

  it("drops a zero-width edge touch — the [start, end) convention", () => {
    // Ends exactly AT the window's start, so it contributes no time.
    expect(wireWindowsFrom([span(0, 1_000)], WINDOW)).toEqual([]);
    // ...and the same at the far edge.
    expect(wireWindowsFrom([span(10_000, 12_000)], WINDOW)).toEqual([]);
  });

  it("merges spans that exactly touch into one", () => {
    // Adjacency-inclusive, unlike the strict overlap test above: two spans
    // meeting at a boundary are one span of admitted time, not two.
    expect(wireWindowsFrom([span(10_000, 20_000), span(20_000, 25_000)], { startMs: 0, endMs: 100_000 })).toEqual([
      { fromMs: 10_000, upToMs: 25_000 },
    ]);
  });

  it("sorts before merging, so input order does not change the mask", () => {
    const ordered = wireWindowsFrom([span(10_000, 20_000), span(18_000, 25_000)], { startMs: 0, endMs: 100_000 });
    const reversed = wireWindowsFrom([span(18_000, 25_000), span(10_000, 20_000)], { startMs: 0, endMs: 100_000 });
    expect(ordered).toEqual([{ fromMs: 10_000, upToMs: 25_000 }]);
    expect(reversed).toEqual(ordered);
  });

  it("swallows a span wholly inside another", () => {
    // The naive `last.upToMs = span.upToMs` merge would SHRINK the mask here.
    expect(wireWindowsFrom([span(10_000, 30_000), span(15_000, 20_000)], { startMs: 0, endMs: 100_000 })).toEqual([
      { fromMs: 10_000, upToMs: 30_000 },
    ]);
  });

  it("clips the scrub-window case the window filter used to own", () => {
    expect(
      wireWindowsFrom([span(10_000, 20_000), span(18_000, 25_000), span(90_000, 95_000)], {
        startMs: 12_000,
        endMs: 90_000,
      })
    ).toEqual([{ fromMs: 12_000, upToMs: 25_000 }]);
  });

  it("does not mutate its input", () => {
    const spans = [span(10_000, 20_000), span(18_000, 25_000)];
    const before = structuredClone(spans);
    wireWindowsFrom(spans, { startMs: 0, endMs: 100_000 });
    expect(spans).toEqual(before);
  });
});
