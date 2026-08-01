import { describe, expect, it } from "vitest";

import { dragToRange } from "./dragRange";

const GEOMETRY = { left: 100, width: 400, maxIndex: 200 };

describe("dragToRange", () => {
  it("maps a left-to-right drag onto bucket indexes", () => {
    expect(dragToRange(200, 300, GEOMETRY)).toEqual([50, 100]);
  });

  it("normalises a right-to-left drag", () => {
    // Dragging backwards selects the same window.
    expect(dragToRange(300, 200, GEOMETRY)).toEqual([50, 100]);
  });

  it("clamps a drag that leaves the plot area", () => {
    expect(dragToRange(-500, 9999, GEOMETRY)).toEqual([0, 200]);
  });

  it("returns null for a click rather than a drag", () => {
    // A click must not collapse the window to nothing.
    expect(dragToRange(200, 202, GEOMETRY)).toBeNull();
  });

  it("returns null for a plot with no width", () => {
    // Measured before layout, or a hidden chart: dividing by zero would put
    // NaN into the window and blank the table.
    expect(dragToRange(200, 300, { left: 100, width: 0, maxIndex: 200 })).toBeNull();
  });
});
