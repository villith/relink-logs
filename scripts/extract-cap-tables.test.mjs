import { describe, expect, it } from "vitest";

import { interpolateCurve, parseCurveTable } from "./extract-cap-tables.mjs";

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

describe("parseCurveTable", () => {
  /** A table in the game's own layout: i64 row count, then 12-byte rows of
   * (u32 character hash, f32 attack rate, f32 damage cap). */
  const table = (rows) => {
    const buffer = Buffer.alloc(8 + rows.length * 12);
    buffer.writeBigInt64LE(BigInt(rows.length), 0);
    rows.forEach(([hash, x, y], i) => {
      buffer.writeUInt32LE(hash, 8 + i * 12);
      buffer.writeFloatLE(x, 8 + i * 12 + 4);
      buffer.writeFloatLE(y, 8 + i * 12 + 8);
    });
    return buffer;
  };

  it("groups rows into one curve per character, keyed by hash", () => {
    const curves = parseCurveTable(
      table([
        [0x18e2f9f9, 0.0, 0],
        [0x18e2f9f9, 1.0, 20000],
        [0x2a26b1b2, 1.0, 30000],
      ])
    );
    expect(curves).toEqual({
      "18e2f9f9": [
        { x: 0, y: 0 },
        { x: 1, y: 20000 },
      ],
      "2a26b1b2": [{ x: 1, y: 30000 }],
    });
  });

  it("sorts each curve by attack rate, since interpolateCurve walks in order", () => {
    // A table whose rows arrive unsorted would otherwise make the walk exit at
    // the first row that happens to exceed the rate, returning a wrong bracket.
    const curves = parseCurveTable(
      table([
        [0x1, 2.0, 45000],
        [0x1, 1.0, 20000],
      ])
    );
    expect(curves["00000001"].map((p) => p.x)).toEqual([1, 2]);
  });

  it("rejects a table whose row size is no longer 12 bytes", () => {
    const wrong = Buffer.alloc(8 + 13);
    wrong.writeBigInt64LE(1n, 0);
    expect(() => parseCurveTable(wrong)).toThrow(/row size/);
  });
});
