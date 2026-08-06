import { describe, expect, it } from "vitest";

import { visibleSlice } from "./windowSlice";

describe("visibleSlice", () => {
  it("covers the viewport plus overscan on both sides", () => {
    // 20px rows, 200px viewport = 10 visible; scrolled to row 50; overscan 5.
    expect(visibleSlice({ scrollTop: 1000, viewportHeight: 200, rowHeight: 20, total: 1000, overscan: 5 })).toEqual({
      start: 45,
      end: 65,
    });
  });

  it("clamps at the top", () => {
    expect(visibleSlice({ scrollTop: 0, viewportHeight: 200, rowHeight: 20, total: 1000, overscan: 5 })).toEqual({
      start: 0,
      end: 15,
    });
  });

  it("clamps at the bottom", () => {
    expect(visibleSlice({ scrollTop: 19_900, viewportHeight: 200, rowHeight: 20, total: 1000, overscan: 5 })).toEqual({
      start: 990,
      end: 1000,
    });
  });

  it("returns an empty slice for an empty list", () => {
    expect(visibleSlice({ scrollTop: 0, viewportHeight: 200, rowHeight: 20, total: 0, overscan: 5 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("survives a viewport it has not measured yet", () => {
    // The scroll container's height is 0 on the first paint, before the ref
    // resolves. Rendering only the overscan there costs one frame; a NaN or a
    // negative end would break Array.prototype.slice's contract.
    expect(visibleSlice({ scrollTop: 0, viewportHeight: 0, rowHeight: 20, total: 1000, overscan: 5 })).toEqual({
      start: 0,
      end: 5,
    });
  });
});
