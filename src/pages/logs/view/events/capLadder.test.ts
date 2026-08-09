import { describe, expect, it } from "vitest";

import { capConsistent, gameCapUp, gameLadderBase, ladderCurveFor } from "./capLadder";

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
