import { describe, expect, it } from "vitest";

import { capConsistent, gameCapUp, gameLadderBase, gameLadderTrace, isSummonClass, ladderCurveFor } from "./capLadder";

describe("isSummonClass", () => {
  it("reads the builder's summon bit (bit 7 of the class flags)", () => {
    expect(isSummonClass(0x81)).toBe(true);
    expect(isSummonClass(0x80)).toBe(true);
    expect(isSummonClass(0x1)).toBe(false);
    expect(isSummonClass(0x40001)).toBe(false);
    expect(isSummonClass(null)).toBe(false);
  });
});

// The standard normal ladder most characters share, as extracted and
// runtime-verified (cap_ladder_dump, 2026-08-09). f32 row values on purpose:
// the game's rows ARE f32, and the walk must reproduce its arithmetic.
const NORMAL = [
  { x: 0, y: 0 },
  { x: 0.1, y: 999 },
  { x: 0.2, y: 1999 },
  { x: 0.3, y: 2999 },
  { x: 0.4, y: 3999 },
  { x: 0.5, y: 4999 },
  { x: 0.6, y: 5999 },
  { x: 0.7, y: 6999 },
  { x: 0.8, y: 7999 },
  { x: 0.9, y: 8999 },
  { x: 1, y: 9999 },
  { x: 2, y: 21999 },
];

describe("gameLadderBase", () => {
  it("interpolates between the bracketing rows", () => {
    // 0.54 sits between (0.5, 4999) and (0.6, 5999): 4999 + 0.4 x 1000.
    expect(gameLadderBase(NORMAL, 0.54)).toBe(5399);
  });

  it("lands exactly on a row value at that row's own rate", () => {
    // The f64 trap this function exists to avoid: 0.2 is not representable, and
    // a double-precision lerp against f32 row values comes out 1998.99…, which
    // truncates to 1998. The game compares and lerps in f32 and gets 1999.
    expect(gameLadderBase(NORMAL, 0.2)).toBe(1999);
    expect(gameLadderBase(NORMAL, 1.0)).toBe(9999);
  });

  it("holds flat outside the table", () => {
    expect(gameLadderBase(NORMAL, -1)).toBe(0);
    expect(gameLadderBase(NORMAL, 50)).toBe(21999);
  });

  it("is zero for an empty curve", () => {
    expect(gameLadderBase([], 1)).toBe(0);
  });
});

describe("gameLadderTrace", () => {
  it("reports the bracketing rows and the lerp it ran between them", () => {
    const trace = gameLadderTrace(NORMAL, 0.54);
    expect(trace.branch).toBe("lerp");
    expect(trace.lo).toEqual({ index: 5, point: { x: 0.5, y: 4999 } });
    expect(trace.hi).toEqual({ index: 6, point: { x: 0.6, y: 5999 } });
    expect(trace.base).toBe(5399);
  });

  it("carries the lerp operands the expression is written from", () => {
    const trace = gameLadderTrace(NORMAL, 0.54);
    // What the panel prints as `4999 + (5999 - 4999) x (0.54 - 0.5) / 0.1`.
    expect(trace.rise).toBeCloseTo(1000, 3);
    expect(trace.span).toBeCloseTo(0.1, 5);
    expect(trace.offset).toBeCloseTo(0.04, 5);
    // At this rate f32 lands exactly on the integer — which is the property
    // this whole module exists for, so it is worth pinning.
    expect(trace.lerped).toBe(5399);
  });

  it("keeps the fraction the trunc drops", () => {
    // 0.5555 interpolates to 5553.9995 in f32, so the game's base is 5553 and
    // not the 5554 the exact arithmetic suggests. Showing the pre-trunc value
    // is how a reader tells that near-miss from a clean hit.
    const trace = gameLadderTrace(NORMAL, 0.5555);
    expect(trace.lerped).toBeCloseTo(5553.9995, 3);
    expect(trace.base).toBe(5553);
  });

  it("names the flat hold below the first row", () => {
    const trace = gameLadderTrace(NORMAL, -1);
    expect(trace.branch).toBe("below");
    expect(trace.lo).toBeNull();
    expect(trace.hi).toEqual({ index: 0, point: { x: 0, y: 0 } });
    expect(trace.base).toBe(0);
  });

  it("names the flat hold past the last row", () => {
    const trace = gameLadderTrace(NORMAL, 50);
    expect(trace.branch).toBe("above");
    expect(trace.lo).toEqual({ index: 11, point: { x: 2, y: 21999 } });
    expect(trace.hi).toBeNull();
    expect(trace.base).toBe(21999);
  });

  it("never brackets a rate with two rows sharing a rate", () => {
    // Why there is no zero-span arm: the walk advances `lo` only while
    // `rate >= lo.x` and stops at the first `rate < hi.x`, so a bracket it
    // returns always spans a positive width. Duplicate rows are simply walked
    // past, and a rate at their shared value holds the last row instead.
    const flat = [
      { x: 0, y: 0 },
      { x: 1, y: 100 },
      { x: 1, y: 500 },
    ];
    expect(gameLadderTrace(flat, 1).branch).toBe("above");
    expect(gameLadderTrace(flat, 1).base).toBe(500);
    expect(gameLadderTrace(flat, 0.5).span).toBeGreaterThan(0);
  });

  it("names an empty curve rather than reporting a zero it walked to", () => {
    const trace = gameLadderTrace([], 1);
    expect(trace.branch).toBe("empty");
    expect(trace.base).toBe(0);
  });

  it("agrees with gameLadderBase at every row rate and between them", () => {
    // The whole point of the refactor: one f32 implementation, so the traced
    // walk cannot drift from the number the tooltip already ships.
    for (const rate of [-1, 0, 0.05, 0.1, 0.2, 0.54, 0.999, 1, 1.5, 2, 50]) {
      expect(gameLadderTrace(NORMAL, rate).base).toBe(gameLadderBase(NORMAL, rate));
    }
  });
});

describe("ladderCurveFor", () => {
  it("keys the normal table by the attacker's character", () => {
    const curve = ladderCurveFor("Pl0300", 0x0);
    expect(curve).not.toBeNull();
    expect(gameLadderBase(curve!, 0.54)).toBe(5399);
  });

  it("selects the arts table for a Skybound Art", () => {
    const normal = ladderCurveFor("Pl0300", 0x0)!;
    const arts = ladderCurveFor("Pl0300", 0x40000)!;
    // The arts ladder is a different curve, not a scaled view of the same one.
    expect(gameLadderBase(arts, 1)).not.toBe(gameLadderBase(normal, 1));
  });

  it("routes a summon hit to the SO0000 curve in the normal map", () => {
    // Bit 7 wins over everything, including the arts bit — the builder tests
    // the sign of the flag byte first.
    const summon = ladderCurveFor("Pl0300", 0x80 | 0x40000);
    expect(summon).toEqual(ladderCurveFor("Pl9999", 0x80));
    expect(summon).not.toBeNull();
  });

  it("declines a character it has no curve for", () => {
    expect(ladderCurveFor("Pl9999", 0x0)).toBeNull();
    expect(ladderCurveFor({ Unknown: 123 }, 0x0)).toBeNull();
    expect(ladderCurveFor("Pl0300", null)).toBeNull();
  });
});

describe("gameCapUp", () => {
  it("divides the logged cap by the ladder base", () => {
    // A real capped hit: cap 152737 at base 5399 is the game's own x28.29.
    expect(gameCapUp(152737, 5399)).toBeCloseTo(27.29, 2);
  });

  it("declines a non-positive base or cap", () => {
    expect(gameCapUp(152737, 0)).toBeNull();
    expect(gameCapUp(0, 5399)).toBeNull();
  });
});

describe("capConsistent", () => {
  it("accepts a cap that is an integer percent multiple of the base", () => {
    // trunc(5399 x 28.29) == 152737 exactly.
    expect(capConsistent(152737, 5399)).toBe(true);
  });

  it("rejects a cap no integer percent count produces", () => {
    // A real non-player line from the 2026-08-08 capture: 46773 / 5399 needs
    // K = 866.3, and neither 866 nor 867 lands on it.
    expect(capConsistent(46773, 5399)).toBe(false);
  });

  it("tolerates f32 accumulation drift at large caps", () => {
    // Real lines: the multiplier is a sum of many f32 terms, so at large bases
    // the product drifts by dozens of cap units off the exact integer grid.
    expect(capConsistent(16689240, 611999)).toBe(true);
    expect(capConsistent(10648412, 395999)).toBe(true);
  });
});
