import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { statusPinKey } from "../../statusUptime";

import { groupByPinKey } from "./useStatusNaming";

const interval = (over: Partial<StatusInterval>): StatusInterval =>
  ({
    actorIndex: 0,
    casterIndex: null,
    statusId: 10,
    abilityId: null,
    statusClass: null,
    casterActionId: null,
    startMs: 0,
    endMs: 1000,
    targetSegment: null,
    ...over,
  }) as StatusInterval;

describe("groupByPinKey", () => {
  it("answers an empty map for no intervals", () => {
    expect(groupByPinKey([]).size).toBe(0);
  });

  it("files two holders of one effect under a single key", () => {
    // The key is the EFFECT (id + cause + class), never the holder — which is
    // what makes one effect one row however many actors held it.
    const grouped = groupByPinKey([interval({ actorIndex: 1 }), interval({ actorIndex: 2 })]);
    expect(grouped.size).toBe(1);
    expect(grouped.get(statusPinKey(interval({})))).toHaveLength(2);
  });

  it("separates two distinct effects", () => {
    const grouped = groupByPinKey([interval({ statusId: 10 }), interval({ statusId: 11 })]);
    expect(grouped.size).toBe(2);
    expect([...grouped.values()].map((group) => group.length)).toEqual([1, 1]);
  });

  it("separates one effect granted by two different causes", () => {
    // Two abilities granting one effect are two rows — the cause is part of
    // the key, which is why the table reads "Attack Up (Signo Drive)".
    const grouped = groupByPinKey([interval({ abilityId: 100 }), interval({ abilityId: 200 })]);
    expect(grouped.size).toBe(2);
  });

  it("keeps each group in the order the intervals arrived", () => {
    const first = interval({ actorIndex: 1, startMs: 500 });
    const second = interval({ actorIndex: 2, startMs: 100 });
    const grouped = groupByPinKey([first, second]);
    // Not sorted: callers that need an ordering apply their own, and a hidden
    // sort here would silently change what `casterActionOf` reads first.
    expect(grouped.get(statusPinKey(first))).toEqual([first, second]);
  });
});
