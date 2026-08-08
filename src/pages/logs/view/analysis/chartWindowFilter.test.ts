import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import {
  admittedBucketsOf,
  intersectWireWindows,
  maskStatusIntervals,
  selectedChartWindows,
  windowFilterScrubRange,
} from "./chartWindowFilter";

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
    expect(selectedChartWindows(WINDOWS, ["sba"])).toEqual([WINDOWS[0], WINDOWS[2]]);
  });

  it("selects one window by 0-based per-kind index", () => {
    expect(selectedChartWindows(WINDOWS, ["sba:1"])).toEqual([WINDOWS[2]]);
  });

  it("a stale index selects nothing — narrows, never widens", () => {
    expect(selectedChartWindows(WINDOWS, ["sba:9"])).toEqual([]);
  });

  it("resolves the index by start order even when the input array isn't sorted", () => {
    const outOfOrder = [win("sba", 50_000, 60_000), win("sba", 10_000, 20_000)];
    expect(selectedChartWindows(outOfOrder, ["sba:1"])).toEqual([outOfOrder[0]]);
  });

  it("unions several values, across kinds, in start order", () => {
    // sba:1 starts at 50s and break:0 at 40s — sorted by start, not by the
    // order the selection was made in.
    expect(selectedChartWindows(WINDOWS, ["sba:1", "break:0"])).toEqual([WINDOWS[3], WINDOWS[2]]);
  });

  it("counts a window once when its kind and its own index are both selected", () => {
    // The kind already admits it; listing it twice would double it in every
    // count built off this list.
    expect(selectedChartWindows(WINDOWS, ["sba", "sba:0"])).toEqual([WINDOWS[0], WINDOWS[2]]);
  });

  it("an empty selection selects nothing — the caller tests length for 'no filter'", () => {
    expect(selectedChartWindows(WINDOWS, [])).toEqual([]);
  });

  it("a stale index does not discard the live values beside it", () => {
    expect(selectedChartWindows(WINDOWS, ["sba:9", "sba:0"])).toEqual([WINDOWS[0]]);
  });
});

describe("windowFilterScrubRange", () => {
  it("covers a single window's hull in whole buckets", () => {
    // Log 1796's SBA window: 222_783..246_171 needs buckets 222 through 246
    // for the scrub's inclusive-bucket window to admit every masked ms.
    expect(windowFilterScrubRange([win("sba", 222_783, 246_171)], 1_000)).toEqual([222, 246]);
  });

  it("a kind selection zooms to the hull from the first start to the last end", () => {
    expect(windowFilterScrubRange([win("sba", 10_500, 20_000), win("sba", 50_000, 61_200)], 1_000)).toEqual([10, 61]);
  });

  it("an end exactly on a bucket edge does not claim the next bucket", () => {
    expect(windowFilterScrubRange([win("link", 5_000, 30_000)], 1_000)).toEqual([5, 29]);
  });

  it("no windows (a stale index) yields no scrub", () => {
    expect(windowFilterScrubRange([], 1_000)).toBeNull();
  });
});

describe("admittedBucketsOf", () => {
  it("marks every bucket a span overlaps, partial buckets included", () => {
    expect(admittedBucketsOf([{ fromMs: 1_500, upToMs: 3_500 }], 5, 1_000)).toEqual([false, true, true, true, false]);
  });

  it("a span ending exactly on a bucket edge does not admit the next bucket", () => {
    expect(admittedBucketsOf([{ fromMs: 1_000, upToMs: 2_000 }], 3, 1_000)).toEqual([false, true, false]);
  });

  it("an empty mask admits nothing", () => {
    expect(admittedBucketsOf([], 2, 1_000)).toEqual([false, false]);
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

describe("maskStatusIntervals", () => {
  const interval = (startMs: number, endMs: number, applications: number) => ({ startMs, endMs, applications });

  it("an interval spanning two disjoint mask spans yields two pieces, counted once at the apply moment", () => {
    const result = maskStatusIntervals(
      [interval(5_000, 25_000, 3)],
      [
        { fromMs: 0, upToMs: 10_000 },
        { fromMs: 20_000, upToMs: 30_000 },
      ]
    );
    expect(result).toEqual([
      { startMs: 5_000, endMs: 10_000, applications: 3 },
      { startMs: 20_000, endMs: 25_000, applications: 0 },
    ]);
    expect(result.reduce((total, piece) => total + piece.applications, 0)).toBe(3);
  });

  it("an interval starting before its first admitting span carries 0 on every piece", () => {
    const result = maskStatusIntervals([interval(0, 15_000, 4)], [{ fromMs: 10_000, upToMs: 20_000 }]);
    expect(result).toEqual([{ startMs: 10_000, endMs: 15_000, applications: 0 }]);
  });

  it("an interval fully inside one span keeps its count", () => {
    const result = maskStatusIntervals([interval(12_000, 18_000, 2)], [{ fromMs: 10_000, upToMs: 20_000 }]);
    expect(result).toEqual([{ startMs: 12_000, endMs: 18_000, applications: 2 }]);
  });

  it("clips piece boundaries to the span", () => {
    const result = maskStatusIntervals([interval(0, 100_000, 1)], [{ fromMs: 10_000, upToMs: 20_000 }]);
    expect(result).toEqual([{ startMs: 10_000, endMs: 20_000, applications: 0 }]);
  });

  it("an interval starting exactly at a span's fromMs counts its applications there", () => {
    const result = maskStatusIntervals(
      [interval(10_000, 15_000, 5)],
      [
        { fromMs: 0, upToMs: 10_000 },
        { fromMs: 10_000, upToMs: 20_000 },
      ]
    );
    expect(result).toEqual([{ startMs: 10_000, endMs: 15_000, applications: 5 }]);
  });

  it("an interval starting exactly at a span's upToMs counts zero there — the start belongs to the NEXT span, if any admits it", () => {
    const result = maskStatusIntervals([interval(10_000, 15_000, 5)], [{ fromMs: 0, upToMs: 10_000 }]);
    expect(result).toEqual([]);

    const withNextSpan = maskStatusIntervals(
      [interval(10_000, 15_000, 5)],
      [
        { fromMs: 0, upToMs: 10_000 },
        { fromMs: 10_000, upToMs: 15_000 },
      ]
    );
    expect(withNextSpan).toEqual([{ startMs: 10_000, endMs: 15_000, applications: 5 }]);
  });
});
