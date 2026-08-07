import { describe, expect, it } from "vitest";

import { clipSpans, mergeSpans, overlapsWindow } from "./spans";

const window = { startMs: 1000, endMs: 2000 };

describe("overlapsWindow", () => {
  it("admits a span covering time inside the window", () => {
    expect(overlapsWindow({ startMs: 1500, endMs: 1600 }, window)).toBe(true);
  });

  it("drops a span that only touches an edge", () => {
    // Zero width inside the window: no time contributed, but a row would draw.
    expect(overlapsWindow({ startMs: 0, endMs: 1000 }, window)).toBe(false);
    expect(overlapsWindow({ startMs: 2000, endMs: 3000 }, window)).toBe(false);
  });
});

describe("clipSpans", () => {
  it("crops to the window and keeps the other fields", () => {
    expect(clipSpans([{ startMs: 500, endMs: 2500, id: "a" }], window)).toEqual([
      { startMs: 1000, endMs: 2000, id: "a" },
    ]);
  });

  it("preserves input order rather than sorting", () => {
    const clipped = clipSpans(
      [
        { startMs: 1800, endMs: 1900, id: "late" },
        { startMs: 1100, endMs: 1200, id: "early" },
      ],
      window
    );
    expect(clipped.map((span) => span.id)).toEqual(["late", "early"]);
  });

  it("does not mutate its input", () => {
    const span = { startMs: 500, endMs: 2500 };
    clipSpans([span], window);
    expect(span).toEqual({ startMs: 500, endMs: 2500 });
  });
});

describe("mergeSpans", () => {
  it("sorts and folds overlapping spans", () => {
    expect(
      mergeSpans([
        { startMs: 1000, endMs: 2000 },
        { startMs: 0, endMs: 1500 },
      ])
    ).toEqual([{ startMs: 0, endMs: 2000 }]);
  });

  it("folds spans that meet exactly at a boundary", () => {
    expect(
      mergeSpans([
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
      ])
    ).toEqual([{ startMs: 0, endMs: 2000 }]);
  });

  it("keeps disjoint spans apart", () => {
    const spans = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ];
    expect(mergeSpans(spans)).toEqual(spans);
  });

  it("keeps a span swallowed whole inside another", () => {
    expect(
      mergeSpans([
        { startMs: 0, endMs: 3000 },
        { startMs: 1000, endMs: 2000 },
      ])
    ).toEqual([{ startMs: 0, endMs: 3000 }]);
  });

  it("folds the payload through `combine`", () => {
    expect(
      mergeSpans(
        [
          { startMs: 0, endMs: 1000, stacks: 1 },
          { startMs: 500, endMs: 2000, stacks: 3 },
        ],
        (into, span) => ({ ...into, stacks: Math.max(into.stacks, span.stacks) })
      )
    ).toEqual([{ startMs: 0, endMs: 2000, stacks: 3 }]);
  });

  it("keeps the earlier payload without a `combine`", () => {
    expect(
      mergeSpans([
        { startMs: 0, endMs: 1000, id: "first" },
        { startMs: 500, endMs: 2000, id: "second" },
      ])
    ).toEqual([{ startMs: 0, endMs: 2000, id: "first" }]);
  });

  it("does not mutate its input", () => {
    const spans = [
      { startMs: 0, endMs: 1000 },
      { startMs: 500, endMs: 2000 },
    ];
    mergeSpans(spans);
    expect(spans).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 500, endMs: 2000 },
    ]);
  });

  it("is empty for no spans", () => {
    expect(mergeSpans([])).toEqual([]);
  });
});
