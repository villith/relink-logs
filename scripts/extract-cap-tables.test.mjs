import { describe, expect, it } from "vitest";

import { interpolateCurve } from "./extract-cap-tables.mjs";

describe("interpolateCurve", () => {
  const curve = [
    { x: 1.0, y: 20000 },
    { x: 2.0, y: 45000 },
    { x: 4.0, y: 100000 },
  ];

  it("interpolates linearly between bracketing points", () => {
    expect(interpolateCurve(curve, 1.5)).toBeCloseTo(32500, 5);
    expect(interpolateCurve(curve, 3.0)).toBeCloseTo(72500, 5);
  });

  it("clamps below the first point and above the last", () => {
    expect(interpolateCurve(curve, 0.5)).toBe(20000);
    expect(interpolateCurve(curve, 9.0)).toBe(100000);
  });

  it("returns a point's own value at an exact match", () => {
    expect(interpolateCurve(curve, 2.0)).toBe(45000);
  });
});
