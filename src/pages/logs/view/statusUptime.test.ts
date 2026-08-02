import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { statusKey, uptimeMs } from "./statusUptime";

const interval = (actor: number, start: number, end: number, ability: number | null = 500): StatusInterval => ({
  actorIndex: actor,
  casterIndex: 0,
  statusId: 10,
  abilityId: ability,
  startMs: start,
  endMs: end,
  maxStacks: 1,
});

describe("uptimeMs", () => {
  it("sums disjoint intervals", () => {
    expect(uptimeMs([interval(1, 0, 1000), interval(1, 2000, 3000)])).toBe(2000);
  });

  it("merges overlapping intervals instead of double counting", () => {
    // Two sources of the same effect on one actor is 100% uptime, not 200%.
    expect(uptimeMs([interval(1, 0, 2000), interval(1, 1000, 3000)])).toBe(3000);
  });

  it("merges intervals that touch exactly", () => {
    expect(uptimeMs([interval(1, 0, 1000), interval(1, 1000, 2000)])).toBe(2000);
  });

  it("is zero for no intervals", () => {
    expect(uptimeMs([])).toBe(0);
  });
});

describe("statusKey", () => {
  it("separates the same effect from different abilities", () => {
    expect(statusKey(interval(1, 0, 1, 500))).not.toBe(statusKey(interval(1, 0, 1, 600)));
  });

  it("gives unresolved causes their own stable key", () => {
    // The documented fallback: no causing ability still groups coherently.
    expect(statusKey(interval(1, 0, 1, null))).toBe("10:unknown");
  });
});
