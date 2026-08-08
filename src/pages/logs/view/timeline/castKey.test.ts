import { describe, expect, it } from "vitest";

import type { EventRow } from "../events/eventRows";

import { castKeyOf } from "./castKey";

const event = (over: Partial<EventRow>): EventRow => ({
  timeMs: 0,
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "spawn",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  capHit: null,
  ...over,
});

describe("castKeyOf", () => {
  it("gives two hits of one skill the same identity", () => {
    expect(castKeyOf(event({ abilityKey: "Normal:100" }), false)).toBe(
      castKeyOf(event({ abilityKey: "Normal:100", timeMs: 900 }), false)
    );
  });

  it("never lets a death share a damage cast", () => {
    // A death marker landing inside a cast window is its own event, not part
    // of the cast — grouping across kinds would swallow it.
    expect(castKeyOf(event({ kind: "death" }), false)).not.toBe(castKeyOf(event({ kind: "damage" }), false));
  });

  it("gives an echo its cause's identity when collapsing", () => {
    expect(castKeyOf(event({ abilityKey: "SupplementaryDamage:100" }), true)).toBe(
      castKeyOf(event({ abilityKey: "Normal:100" }), true)
    );
  });

  it("leaves an echo its own identity without collapsing", () => {
    expect(castKeyOf(event({ abilityKey: "SupplementaryDamage:100" }), false)).not.toBe(
      castKeyOf(event({ abilityKey: "Normal:100" }), false)
    );
  });
});
