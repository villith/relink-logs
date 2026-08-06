import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { auraExcludedBands, auraHolderIntervals, auraWireWindows } from "./auraWindows";

const interval = (
  actor: number,
  start: number,
  end: number,
  status = 10,
  ability: number | null = 500,
  targetSegment: number | null = null
): StatusInterval => ({
  actorIndex: actor,
  casterIndex: 0,
  statusId: status,
  abilityId: ability,
  // A log written before the provenance fields existed reads back null for
  // both, so every fixture here is also the class-less regression case.
  statusClass: null,
  casterActionId: null,
  startMs: start,
  endMs: end,
  maxStacks: 1,
  targetSegment,
  applications: 1,
});

describe("auraHolderIntervals", () => {
  const INTERVALS = [
    interval(0, 0, 5_000, 10, 500),
    interval(1, 0, 2_000, 10, 500), // other player, same effect
    interval(0, 0, 1_000, 20, 600), // same player, other effect
    interval(9, 0, 6_000, 10, 500, 2), // enemy spawn 2, same effect
  ];

  it("selects one player holder's windows of one effect", () => {
    const held = auraHolderIntervals(INTERVALS, "status:10:500:unknown", { kind: "player", index: 0 });
    expect(held).toEqual([INTERVALS[0]]);
  });

  it("selects an enemy holder by SPAWN segment, never actor index", () => {
    const held = auraHolderIntervals(INTERVALS, "status:10:500:unknown", { kind: "enemySpawn", segment: 2 });
    expect(held).toEqual([INTERVALS[3]]);
  });
});

describe("auraWireWindows", () => {
  const WINDOW = { startMs: 1_000, endMs: 10_000 };

  it("clips to the chart window and merges overlaps, in fight-relative ms", () => {
    const windows = auraWireWindows(
      [interval(0, 0, 3_000), interval(0, 2_000, 5_000), interval(0, 8_000, 12_000)],
      WINDOW
    );
    expect(windows).toEqual([
      { fromMs: 1_000, upToMs: 5_000 },
      { fromMs: 8_000, upToMs: 10_000 },
    ]);
  });

  it("answers empty when the effect was never up inside the window", () => {
    expect(auraWireWindows([interval(0, 20_000, 30_000)], WINDOW)).toEqual([]);
    expect(auraWireWindows([], WINDOW)).toEqual([]);
  });

  it("drops a zero-width edge touch — the [start, end) convention", () => {
    // Ends exactly AT the window's start: contributes nothing.
    expect(auraWireWindows([interval(0, 0, 1_000)], WINDOW)).toEqual([]);
  });
});

describe("auraExcludedBands", () => {
  const WINDOW = { startMs: 1_000, endMs: 10_000 };

  it("shades the complement, rebased onto the window's start", () => {
    expect(
      auraExcludedBands(
        [
          { fromMs: 2_000, upToMs: 4_000 },
          { fromMs: 6_000, upToMs: 7_000 },
        ],
        WINDOW
      )
    ).toEqual([
      { startMs: 0, endMs: 1_000, stacks: 1 },
      { startMs: 3_000, endMs: 5_000, stacks: 1 },
      { startMs: 6_000, endMs: 9_000, stacks: 1 },
    ]);
  });

  it("shades nothing when the mask covers the whole window", () => {
    expect(auraExcludedBands([{ fromMs: 1_000, upToMs: 10_000 }], WINDOW)).toEqual([]);
  });

  it("shades everything when the mask is empty", () => {
    expect(auraExcludedBands([], WINDOW)).toEqual([{ startMs: 0, endMs: 9_000, stacks: 1 }]);
  });
});
