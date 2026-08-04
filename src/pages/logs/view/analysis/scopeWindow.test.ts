import { describe, expect, it } from "vitest";

import { windowFromDrag } from "./scopeWindow";

describe("windowFromDrag", () => {
  it("orders the pair regardless of drag direction", () => {
    expect(windowFromDrag(40, 12, 100)).toEqual([12, 40]);
    expect(windowFromDrag(12, 40, 100)).toEqual([12, 40]);
  });

  it("treats a drag that never moved as a click, not a window", () => {
    expect(windowFromDrag(30, 30, 100)).toBeNull();
  });

  it("treats a drag spanning the whole plot as clearing the window", () => {
    // Selecting everything means "no window", not a refetch of an identical one.
    expect(windowFromDrag(0, 100, 100)).toBeNull();
  });

  it("keeps a window that reaches only one end", () => {
    expect(windowFromDrag(0, 40, 100)).toEqual([0, 40]);
    expect(windowFromDrag(60, 100, 100)).toEqual([60, 100]);
  });
});
