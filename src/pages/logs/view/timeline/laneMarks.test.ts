import { describe, expect, it } from "vitest";

import type { EventRow } from "../events/eventRows";
import type { MetricRow } from "../metrics/types";

import { CAST_MAX_MS, lanesFor, markGapMs, marksByLane, mergeCasts, mergeMarks, type LaneMark } from "./laneMarks";
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
  capHit: null,
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

/** A mark with the fields a case is not about already filled in. Written once
 * so adding a field to `LaneMark` does not mean editing twenty literals — and
 * so a case that IS about `hits`/`casts`/`castKey` states them visibly. */
const mark = (over: Partial<LaneMark>): LaneMark => ({
  startMs: 0,
  endMs: 0,
  count: 1,
  amount: null,
  by: [],
  hits: [],
  casts: 1,
  castKey: "",
  ...over,
});

describe("marksByLane", () => {
  // Rebased onto the window's own start, exactly as `MetricRow.timeline` is —
  // so a bar and a tick on the same chart measure from one origin.
  it("rebases each mark onto the window start", () => {
    const marks = marksByLane([event({ timeMs: 7000, amount: 100 })], ALL_TO_A, { startMs: 5000, endMs: 15000 });
    expect(marks.get("a")).toEqual([
      mark({
        startMs: 2000,
        endMs: 2000,
        amount: 100,
        by: [{ key: "", count: 1, amount: 100 }],
        hits: [{ atMs: 2000, echo: false }],
        // The kind is always part of a cast identity, even for an event that
        // names no ability at all — see `castKeyOf`.
        castKey: "damage|",
      }),
    ]);
  });

  it("drops events outside the window", () => {
    const events = [event({ timeMs: 1000 }), event({ timeMs: 7000 }), event({ timeMs: 99000 })];
    const marks = marksByLane(events, ALL_TO_A, { startMs: 5000, endMs: 15000 });
    expect(marks.get("a")).toHaveLength(1);
  });

  // Half-open, `[startMs, endMs)` — the rule the rest of the pipeline follows.
  // `statusWindow.endMs` is the first millisecond of the bucket AFTER the
  // window, and the group query stops at `endMs - 1`, so admitting `endMs`
  // here would put a mark on the timeline for a hit the table did not count.
  it("admits the window's first millisecond and excludes its last", () => {
    const events = [event({ timeMs: 5000 }), event({ timeMs: 14999 }), event({ timeMs: 15000 })];
    const marks = marksByLane(events, ALL_TO_A, { startMs: 5000, endMs: 15000 });
    expect(marks.get("a")?.map((mark) => mark.startMs)).toEqual([0, 9999]);
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
    const marks = [mark({ startMs: 0, endMs: 0, amount: 10 }), mark({ startMs: 50, endMs: 50, amount: 20 })];
    expect(mergeMarks(marks, 100)).toEqual([mark({ startMs: 0, endMs: 50, count: 2, amount: 30, casts: 2 })]);
  });

  it("keeps marks further apart than the gap separate", () => {
    const marks = [mark({ startMs: 0, endMs: 0, amount: 10 }), mark({ startMs: 500, endMs: 500, amount: 20 })];
    expect(mergeMarks(marks, 100)).toHaveLength(2);
  });

  it("sorts before merging, so event order cannot change the result", () => {
    const marks = [mark({ startMs: 50, endMs: 50, amount: 20 }), mark({ startMs: 0, endMs: 0, amount: 10 })];
    expect(mergeMarks(marks, 100)).toEqual([mark({ startMs: 0, endMs: 50, count: 2, amount: 30, casts: 2 })]);
  });

  // A lane where nothing carried an amount must not report 0 — that reads as a
  // measured zero rather than as "this kind has no amount".
  it("keeps a null amount null when no mark carried one", () => {
    const marks = [mark({ startMs: 0, endMs: 0, amount: null }), mark({ startMs: 50, endMs: 50, amount: null })];
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
    expect(lanes[0]?.marks).toEqual([mark({ startMs: 0, endMs: 4000 })]);
  });

  it("draws merged event marks for a row with no timeline", () => {
    const rows = [metricRow({ key: "skill:Normal:100", kind: "ability" })];
    const byLane = new Map([
      ["skill:Normal:100", [mark({ startMs: 0, endMs: 0, amount: 10 }), mark({ startMs: 50, endMs: 50, amount: 20 })]],
    ]);
    const lanes = lanesFor(rows, byLane, 100);
    expect(lanes[0]?.spans).toBe(false);
    // ONE cast, not two: the cast fold runs first and two same-identity hits
    // 50ms apart are one cast, so the density fold has nothing left to merge.
    expect(lanes[0]?.marks).toEqual([mark({ startMs: 0, endMs: 50, count: 2, amount: 30, casts: 1 })]);
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

describe("mark contributions", () => {
  // A mark folds several hits; the card behind it lists what they were, so
  // each mark has to remember its parts rather than only their sum.
  it("records the action behind a single event", () => {
    const marks = marksByLane([event({ timeMs: 1000, abilityKey: "Normal:100", amount: 500 })], ALL_TO_A, {
      startMs: 0,
      endMs: 10_000,
    });
    expect(marks.get("a")?.[0]?.by).toEqual([{ key: "Normal:100", count: 1, amount: 500 }]);
  });

  it("folds contributions of the same action together when marks merge", () => {
    const marks = [
      mark({ startMs: 0, endMs: 0, amount: 10, by: [{ key: "A", count: 1, amount: 10 }] }),
      mark({ startMs: 50, endMs: 50, amount: 20, by: [{ key: "A", count: 1, amount: 20 }] }),
    ];
    expect(mergeMarks(marks, 100)[0]?.by).toEqual([{ key: "A", count: 2, amount: 30 }]);
  });

  // The card lists largest first, so a merge must keep distinct actions apart
  // and order them.
  it("keeps distinct actions apart and sorts them by amount", () => {
    const marks = [
      mark({ startMs: 0, endMs: 0, amount: 10, by: [{ key: "A", count: 1, amount: 10 }] }),
      mark({ startMs: 50, endMs: 50, amount: 90, by: [{ key: "B", count: 1, amount: 90 }] }),
    ];
    expect(mergeMarks(marks, 100)[0]?.by).toEqual([
      { key: "B", count: 1, amount: 90 },
      { key: "A", count: 1, amount: 10 },
    ]);
  });

  // An effect names no action; its key is the status key so the card can name
  // it through the same `status:` grammar the tables use.
  it("uses the status key for an effect event", () => {
    const marks = marksByLane(
      [event({ timeMs: 1000, kind: "status", statusKey: "status:77:210", amount: null })],
      ALL_TO_A,
      { startMs: 0, endMs: 10_000 }
    );
    expect(marks.get("a")?.[0]?.by).toEqual([{ key: "status:77:210", count: 1, amount: 0 }]);
  });

  // A row's own timeline spans are not an event fold and have nothing to list.
  it("gives a span mark no contributions", () => {
    const rows = [metricRow({ key: "s", kind: "status", timeline: [{ startMs: 0, endMs: 4000 }] })];
    expect(lanesFor(rows, new Map(), 100)[0]?.marks[0]?.by).toEqual([]);
  });
});

describe("mergeCasts", () => {
  const hit = (startMs: number, castKey = "damage|Normal:100"): LaneMark => ({
    startMs,
    endMs: startMs,
    count: 1,
    amount: 100,
    by: [{ key: "Normal:100", count: 1, amount: 100 }],
    hits: [{ atMs: startMs, echo: false }],
    casts: 1,
    castKey,
  });

  it("folds hits of one skill inside the idle gap into one cast", () => {
    const merged = mergeCasts([hit(0), hit(400), hit(900)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(3);
    expect(merged[0].endMs).toBe(900);
    expect(merged[0].hits.map((h) => h.atMs)).toEqual([0, 400, 900]);
  });

  it("starts a new cast once the idle gap is exceeded", () => {
    expect(mergeCasts([hit(0), hit(1_500)])).toHaveLength(2);
  });

  it("never folds two different skills together", () => {
    expect(mergeCasts([hit(0), hit(100, "damage|Normal:200")])).toHaveLength(2);
  });

  it("splits a chain that outgrows the cast ceiling", () => {
    // Without a ceiling a continuously attacking player's auto-attack lane
    // chains every hit in the fight into one enormous "cast".
    const chain = Array.from({ length: 20 }, (_, index) => hit(index * 500));
    const merged = mergeCasts(chain);
    expect(merged.length).toBeGreaterThan(1);
    expect(Math.max(...merged.map((mark) => mark.endMs - mark.startMs))).toBeLessThanOrEqual(CAST_MAX_MS);
  });

  it("is independent of the zoom-derived gap", () => {
    // The whole point: a cast must not split when you zoom in.
    expect(mergeMarks(mergeCasts([hit(0), hit(400)]), 0)).toHaveLength(1);
  });
});

describe("mergeMarks — casts", () => {
  it("counts the casts it folds together", () => {
    const cast = (startMs: number): LaneMark => ({
      startMs,
      endMs: startMs + 100,
      count: 2,
      amount: 200,
      by: [],
      hits: [],
      casts: 1,
      castKey: "damage|Normal:100",
    });
    const merged = mergeMarks([cast(0), cast(150)], 100);
    expect(merged).toHaveLength(1);
    expect(merged[0].casts).toBe(2);
  });
});
