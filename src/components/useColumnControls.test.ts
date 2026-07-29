import { describe, expect, it } from "vitest";

import { toggleColumn } from "./useColumnControls";

// Column reordering goes through `moveItem` (src/utils.ts), which is covered there.
describe("column helpers", () => {
  it("toggleColumn flips visibility of the matching column and keeps its position", () => {
    const settings = [
      { id: "a", visible: true },
      { id: "b", visible: true },
      { id: "c", visible: false },
    ];

    // Hiding "a" keeps it first in the list (order unchanged), just not visible.
    expect(toggleColumn(settings, "a")).toEqual([
      { id: "a", visible: false },
      { id: "b", visible: true },
      { id: "c", visible: false },
    ]);

    // Showing "c" keeps it last.
    expect(toggleColumn(settings, "c")).toEqual([
      { id: "a", visible: true },
      { id: "b", visible: true },
      { id: "c", visible: true },
    ]);
  });

  it("toggleColumn leaves other columns untouched", () => {
    const settings = [
      { id: "a", visible: true },
      { id: "b", visible: false },
    ];
    expect(toggleColumn(settings, "z")).toEqual(settings);
  });
});
