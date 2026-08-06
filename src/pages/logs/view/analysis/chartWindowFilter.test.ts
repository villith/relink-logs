import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { intersectWireWindows, selectedChartWindows, windowFilterWireWindows } from "./chartWindowFilter";

const win = (kind: ChartWindow["kind"], startMs: number, endMs: number, actorIndex: number | null = null) => ({
  kind,
  startMs,
  endMs,
  actorIndex,
});

const WINDOWS: ChartWindow[] = [
  win("sba", 10_000, 20_000),
  win("link", 15_000, 30_000),
  win("sba", 50_000, 60_000),
  win("break", 40_000, 55_000, 7),
];

describe("selectedChartWindows", () => {
  it("selects a whole kind in start order", () => {
    expect(selectedChartWindows(WINDOWS, "sba")).toEqual([WINDOWS[0], WINDOWS[2]]);
  });

  it("selects one window by 0-based per-kind index", () => {
    expect(selectedChartWindows(WINDOWS, "sba:1")).toEqual([WINDOWS[2]]);
  });

  it("a stale index selects nothing — narrows, never widens", () => {
    expect(selectedChartWindows(WINDOWS, "sba:9")).toEqual([]);
  });

  it("resolves the index by start order even when the input array isn't sorted", () => {
    const outOfOrder = [win("sba", 50_000, 60_000), win("sba", 10_000, 20_000)];
    expect(selectedChartWindows(outOfOrder, "sba:1")).toEqual([outOfOrder[0]]);
  });
});

describe("windowFilterWireWindows", () => {
  it("clips to the scrub window, merges overlaps, drops edge touches", () => {
    const wire = windowFilterWireWindows(
      [win("sba", 10_000, 20_000), win("sba", 18_000, 25_000), win("sba", 90_000, 95_000)],
      { startMs: 12_000, endMs: 90_000 }
    );
    expect(wire).toEqual([{ fromMs: 12_000, upToMs: 25_000 }]);
  });

  it("no selected windows is an empty mask", () => {
    expect(windowFilterWireWindows([], { startMs: 0, endMs: 100_000 })).toEqual([]);
  });

  it("merges spans that exactly touch into one", () => {
    const wire = windowFilterWireWindows([win("sba", 10_000, 20_000), win("sba", 20_000, 25_000)], {
      startMs: 0,
      endMs: 100_000,
    });
    expect(wire).toEqual([{ fromMs: 10_000, upToMs: 25_000 }]);
  });
});

describe("intersectWireWindows", () => {
  it("keeps only time inside both masks", () => {
    expect(
      intersectWireWindows(
        [
          { fromMs: 0, upToMs: 10_000 },
          { fromMs: 20_000, upToMs: 30_000 },
        ],
        [{ fromMs: 5_000, upToMs: 25_000 }]
      )
    ).toEqual([
      { fromMs: 5_000, upToMs: 10_000 },
      { fromMs: 20_000, upToMs: 25_000 },
    ]);
  });

  it("disjoint masks intersect to nothing", () => {
    expect(intersectWireWindows([{ fromMs: 0, upToMs: 5_000 }], [{ fromMs: 5_000, upToMs: 9_000 }])).toEqual([]);
  });
});
