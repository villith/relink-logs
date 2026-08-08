import { describe, expect, it } from "vitest";

import { combineMasks, intersectMasks } from "./useFilterWindows";

describe("combineMasks", () => {
  it("is undefined when neither filter is active", () => {
    // Undefined means "no filter at all", which is the only value that leaves
    // the fight whole. It must never be confused with an empty mask.
    expect(combineMasks(undefined, undefined)).toBeUndefined();
  });

  it("passes either filter through alone, by reference", () => {
    // By reference on purpose: the caller memoises these, and rebuilding one
    // here would give every consumer a fresh identity each render.
    const aura = [{ fromMs: 0, upToMs: 10 }];
    const windows = [{ fromMs: 5, upToMs: 20 }];
    expect(combineMasks(aura, undefined)).toBe(aura);
    expect(combineMasks(undefined, windows)).toBe(windows);
  });

  it("intersects when both are active", () => {
    expect(combineMasks([{ fromMs: 0, upToMs: 10 }], [{ fromMs: 5, upToMs: 20 }])).toEqual([{ fromMs: 5, upToMs: 10 }]);
  });

  it("keeps an EMPTY mask, which narrows to nothing", () => {
    // An empty array is a real answer — the effect was never up inside the
    // window, or the chip resolved to a stale index — and the aggregator masks
    // everything for it. Narrowing, never widening.
    expect(combineMasks([], undefined)).toEqual([]);
    expect(combineMasks(undefined, [])).toEqual([]);
  });

  it("intersects an empty mask to empty rather than falling back to the other", () => {
    // The trap this guards: treating [] as falsy would widen the fight back to
    // the other filter's spans, showing damage the active filter excluded.
    expect(combineMasks([], [{ fromMs: 0, upToMs: 10 }])).toEqual([]);
  });

  it("drops spans that do not overlap at all", () => {
    expect(combineMasks([{ fromMs: 0, upToMs: 5 }], [{ fromMs: 10, upToMs: 20 }])).toEqual([]);
  });
});

describe("intersectMasks", () => {
  it("is undefined with no masks — no aura filter, rather than an empty one", () => {
    expect(intersectMasks([])).toBeUndefined();
  });

  it("passes a lone mask through by reference", () => {
    const only = [{ fromMs: 0, upToMs: 10 }];
    expect(intersectMasks([only])).toBe(only);
  });

  it("folds three masks into the time ALL of them were up", () => {
    // What the multi-select is for: "what did we do under the full stack",
    // which a union could not answer.
    expect(
      intersectMasks([[{ fromMs: 0, upToMs: 100 }], [{ fromMs: 20, upToMs: 80 }], [{ fromMs: 50, upToMs: 200 }]])
    ).toEqual([{ fromMs: 50, upToMs: 80 }]);
  });

  it("a stack that never lined up is EMPTY, not absent", () => {
    // Empty narrows the view to nothing, which is the honest reading — falling
    // back to a wider mask would show damage the filter excluded.
    expect(intersectMasks([[{ fromMs: 0, upToMs: 10 }], [{ fromMs: 50, upToMs: 60 }]])).toEqual([]);
  });

  it("keeps every disjoint stretch where the stack held", () => {
    expect(
      intersectMasks([
        [
          { fromMs: 0, upToMs: 30 },
          { fromMs: 60, upToMs: 90 },
        ],
        [
          { fromMs: 10, upToMs: 70 },
          { fromMs: 80, upToMs: 100 },
        ],
      ])
    ).toEqual([
      { fromMs: 10, upToMs: 30 },
      { fromMs: 60, upToMs: 70 },
      { fromMs: 80, upToMs: 90 },
    ]);
  });
});
