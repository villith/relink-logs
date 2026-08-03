import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import { identityPartyOf } from "./partyIdentity";

const party = (indexes: number[]) =>
  Object.fromEntries(indexes.map((index) => [String(index), { index, totalDamage: 100 } as ComputedPlayerState]));

describe("identityPartyOf", () => {
  it("keeps every party slot when a scope narrows the party to one player", () => {
    // The scoped fetch returns only the pinned player. Slotting from THAT
    // makes the pinned player slot 0, so they inherit slot 0's name and colour.
    const base = party([0, 1, 2, 3]);
    const scoped = party([2]);
    expect(identityPartyOf(base, scoped).map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it("gives each player the slot its actor index earns, not its array position", () => {
    const base = party([0, 1, 2, 3]);
    const found = identityPartyOf(base, party([2])).find((p) => p.index === 2);
    expect(found?.partyIndex).toBe(2);
  });

  it("falls back to the scoped party when there is no base load yet", () => {
    expect(identityPartyOf(null, party([1])).map((p) => p.index)).toEqual([1]);
  });

  it("returns nothing when neither party exists", () => {
    expect(identityPartyOf(null, null)).toEqual([]);
  });
});
