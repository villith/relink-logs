import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { groupBy } from "./groupBy";
import { statusKey, statusPinKey, uptimeMs } from "./statusUptime";

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

describe("grouping intervals by statusPinKey", () => {
  const grouped = (intervals: StatusInterval[]) => groupBy(intervals, statusPinKey);

  it("answers an empty map for no intervals", () => {
    expect(grouped([]).size).toBe(0);
  });

  it("files two holders of one effect under a single key", () => {
    // The key is the EFFECT (id + cause + class), never the holder — which is
    // what makes one effect one row however many actors held it.
    const groups = grouped([interval(1, 0, 1000), interval(2, 0, 1000)]);
    expect(groups.size).toBe(1);
    expect(groups.get(statusPinKey(interval(1, 0, 1000)))).toHaveLength(2);
  });

  it("separates two distinct effects", () => {
    const groups = grouped([
      { ...interval(1, 0, 1000), statusId: 10 },
      { ...interval(1, 0, 1000), statusId: 11 },
    ]);
    expect(groups.size).toBe(2);
    expect([...groups.values()].map((group) => group.length)).toEqual([1, 1]);
  });

  it("separates one effect granted by two different causes", () => {
    // Two abilities granting one effect are two rows — the cause is part of
    // the key, which is why the table reads "Attack Up (Signo Drive)".
    expect(grouped([interval(1, 0, 1000, 100), interval(1, 0, 1000, 200)]).size).toBe(2);
  });

  it("keeps each group in the order the intervals arrived", () => {
    const first = interval(1, 500, 1000);
    const second = interval(2, 100, 1000);
    // Not sorted: callers that need an ordering apply their own, and a hidden
    // sort here would silently change what `casterActionOf` reads first.
    expect(grouped([first, second]).get(statusPinKey(first))).toEqual([first, second]);
  });
});
