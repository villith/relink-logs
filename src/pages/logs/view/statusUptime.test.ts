import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { statusKey, uptimeMs } from "./statusUptime";

const interval = (actor: number, start: number, end: number, ability: number | null = 500): StatusInterval => ({
  actorIndex: actor,
  casterIndex: 0,
  statusId: 10,
  abilityId: ability,
  statusClass: null,
  casterActionId: null,
  startMs: start,
  endMs: end,
  maxStacks: 1,
  targetSegment: null,
  applications: 1,
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
    expect(statusKey(interval(1, 0, 1, null))).toBe("10:unknown:unknown");
  });

  it("separates the same effect and cause applied by different classes", () => {
    // What the third segment buys: a passive whose cause is a sentinel is told
    // apart by the object that applied it, so Guardpoint and Ares no longer
    // share one "(9998)" row.
    const guardpoint = { ...interval(1, 0, 1, 9998), statusClass: 43981 };
    const ares = { ...interval(1, 0, 1, 9998), statusClass: 1234 };
    expect(statusKey(guardpoint)).not.toBe(statusKey(ares));
  });

  it("spells an absent class rather than omitting the segment", () => {
    // One grammar shape for all four readers: a class-less log still writes
    // three segments, so it groups exactly as it did before this change.
    expect(statusKey(interval(1, 0, 1, 500))).toBe("10:500:unknown");
  });
});
