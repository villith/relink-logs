import { describe, expect, it } from "vitest";

import { chainKey, groupRepeatChains } from "./repeatChains";

type Row = { id: number; repeatGroup?: number | null };

const row = (id: number, repeatGroup: number | null = null): Row => ({ id, repeatGroup });

describe("groupRepeatChains", () => {
  it("passes unchained logs through as single-row groups", () => {
    const groups = groupRepeatChains([row(3), row(2), row(1)]);

    expect(groups.map((g) => g.leader.id)).toEqual([3, 2, 1]);
    expect(groups.every((g) => g.rest.length === 0)).toBe(true);
  });

  it("collapses a chain under its first row in display order", () => {
    // Default sort is newest-first, so the parent (oldest run, id 7) comes
    // last and a newer run leads the group.
    const groups = groupRepeatChains([row(9, 7), row(8, 7), row(7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(9);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8, 7]);
  });

  it("groups a chain in ascending order too", () => {
    const groups = groupRepeatChains([row(7), row(8, 7), row(9, 7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(7);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8, 9]);
  });

  it("groups chain rows even when the parent row is not on the page", () => {
    const groups = groupRepeatChains([row(9, 7), row(8, 7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(9);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8]);
  });

  it("only groups consecutive rows, so a foreign sort order degrades gracefully", () => {
    // Sorted by e.g. duration, an unrelated row can sit inside the chain;
    // merging across it would visually reorder the list.
    const groups = groupRepeatChains([row(9, 7), row(5), row(8, 7)]);

    expect(groups.map((g) => g.leader.id)).toEqual([9, 5, 8]);
    expect(groups.every((g) => g.rest.length === 0)).toBe(true);
  });

  it("keeps two different chains apart", () => {
    const groups = groupRepeatChains([row(9, 7), row(7), row(4, 2), row(2)]);

    expect(groups.map((g) => g.leader.id)).toEqual([9, 4]);
    expect(groups[0].rest.map((r) => r.id)).toEqual([7]);
    expect(groups[1].rest.map((r) => r.id)).toEqual([2]);
  });
});

describe("chainKey", () => {
  it("is the parent id for chained rows and the own id otherwise", () => {
    expect(chainKey(row(9, 7))).toBe(7);
    expect(chainKey(row(7))).toBe(7);
    expect(chainKey(row(5, null))).toBe(5);
  });
});
