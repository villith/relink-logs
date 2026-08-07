import { describe, expect, it } from "vitest";

import type { EventRow } from "../events/eventRows";
import type { MetricRow } from "../metrics/types";

import { lanesFor, markGapMs, marksByLane, mergeMarks } from "./laneMarks";
import type { LaneMatcher } from "./laneMatch";

const event = (over: Partial<EventRow>): EventRow => ({
  timeMs: 0,
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  ...over,
});

const metricRow = (over: Partial<MetricRow>): MetricRow => ({
  key: "",
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

/** Every event lands on lane "a". */
const ALL_TO_A: LaneMatcher = { laneOf: () => "a" };

describe("marksByLane", () => {
  // Rebased onto the window's own start, exactly as `MetricRow.timeline` is —
  // so a bar and a tick on the same chart measure from one origin.
  it("rebases each mark onto the window start", () => {
    const marks = marksByLane([event({ timeMs: 7000, amount: 100 })], ALL_TO_A, { startMs: 5000, endMs: 15000 });
    expect(marks.get("a")).toEqual([{ startMs: 2000, endMs: 2000, count: 1, amount: 100 }]);
  });

  it("drops events outside the window", () => {
    const events = [event({ timeMs: 1000 }), event({ timeMs: 7000 }), event({ timeMs: 99000 })];
    const marks = marksByLane(events, ALL_TO_A, { startMs: 5000, endMs: 15000 });
    expect(marks.get("a")).toHaveLength(1);
  });

  it("drops events no lane claims", () => {
    const marks = marksByLane([event({ timeMs: 1000 })], { laneOf: () => null }, { startMs: 0, endMs: 10000 });
    expect(marks.size).toBe(0);
  });
});

describe("mergeMarks", () => {
  // The whole point: at a scale where two hits are a pixel apart, drawing two
  // marks draws one smear. Merging says so honestly and keeps the count.
  it("folds marks closer together than the gap", () => {
    const marks = [
      { startMs: 0, endMs: 0, count: 1, amount: 10 },
      { startMs: 50, endMs: 50, count: 1, amount: 20 },
    ];
    expect(mergeMarks(marks, 100)).toEqual([{ startMs: 0, endMs: 50, count: 2, amount: 30 }]);
  });

  it("keeps marks further apart than the gap separate", () => {
    const marks = [
      { startMs: 0, endMs: 0, count: 1, amount: 10 },
      { startMs: 500, endMs: 500, count: 1, amount: 20 },
    ];
    expect(mergeMarks(marks, 100)).toHaveLength(2);
  });

  it("sorts before merging, so event order cannot change the result", () => {
    const marks = [
      { startMs: 50, endMs: 50, count: 1, amount: 20 },
      { startMs: 0, endMs: 0, count: 1, amount: 10 },
    ];
    expect(mergeMarks(marks, 100)).toEqual([{ startMs: 0, endMs: 50, count: 2, amount: 30 }]);
  });

  // A lane where nothing carried an amount must not report 0 — that reads as a
  // measured zero rather than as "this kind has no amount".
  it("keeps a null amount null when no mark carried one", () => {
    const marks = [
      { startMs: 0, endMs: 0, count: 1, amount: null },
      { startMs: 50, endMs: 50, count: 1, amount: null },
    ];
    expect(mergeMarks(marks, 100)[0]?.amount).toBeNull();
  });

  it("returns an empty list untouched", () => {
    expect(mergeMarks([], 100)).toEqual([]);
  });
});

describe("markGapMs", () => {
  it("converts a pixel threshold into milliseconds at the current scale", () => {
    // 900px showing 30s → 30px per second. A 3px threshold is 100ms.
    expect(markGapMs({ widthPx: 900, viewportMs: 30_000, gapPx: 3 })).toBe(100);
  });

  // Before the container has been measured its width is 0; dividing by it
  // would make every mark on every lane merge into one.
  it("answers zero when the container has not been measured", () => {
    expect(markGapMs({ widthPx: 0, viewportMs: 30_000, gapPx: 3 })).toBe(0);
  });
});

describe("lanesFor", () => {
  // Buffs and Debuffs already carry their real spans; the timeline draws them
  // rather than re-deriving anything.
  it("draws a row's own timeline spans when it has them", () => {
    const rows = [metricRow({ key: "status:77:210", kind: "status", timeline: [{ startMs: 0, endMs: 4000 }] })];
    const lanes = lanesFor(rows, new Map(), 100);
    expect(lanes[0]?.spans).toBe(true);
    expect(lanes[0]?.marks).toEqual([{ startMs: 0, endMs: 4000, count: 1, amount: null }]);
  });

  it("draws merged event marks for a row with no timeline", () => {
    const rows = [metricRow({ key: "skill:Normal:100", kind: "ability" })];
    const byLane = new Map([
      [
        "skill:Normal:100",
        [
          { startMs: 0, endMs: 0, count: 1, amount: 10 },
          { startMs: 50, endMs: 50, count: 1, amount: 20 },
        ],
      ],
    ]);
    const lanes = lanesFor(rows, byLane, 100);
    expect(lanes[0]?.spans).toBe(false);
    expect(lanes[0]?.marks).toEqual([{ startMs: 0, endMs: 50, count: 2, amount: 30 }]);
  });

  // A row the join could not place still gets a lane. Dropping it would make
  // the timeline disagree with the table about which rows exist.
  it("keeps a lane for a row with nothing to draw", () => {
    const rows = [metricRow({ key: "skill:Normal:100", kind: "ability" })];
    const lanes = lanesFor(rows, new Map(), 100);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.marks).toEqual([]);
  });

  it("keeps the rows in the order it was given them", () => {
    const rows = [metricRow({ key: "a", kind: "ability" }), metricRow({ key: "b", kind: "ability" })];
    expect(lanesFor(rows, new Map(), 100).map((lane) => lane.row.key)).toEqual(["a", "b"]);
  });
});
