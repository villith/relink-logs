import { describe, expect, it } from "vitest";

import type { ChartDatapoint } from "../DetailCharts";

import { ROLLUP_SERIES_KEY, rollupIsDrawn, withRollupSeries } from "./chartRollup";

/** ChartDatapoint intersects a string `timestamp` with a numeric index
 * signature, so no literal carrying both satisfies it structurally — the view
 * casts for the same reason where it builds these. */
const point = (timestamp: string, values: Record<string, number>) =>
  ({ timestamp, ...values }) as unknown as ChartDatapoint;

const DATA: ChartDatapoint[] = [
  point("00:01", { a: 100, b: 50, c: 20, d: 5 }),
  point("00:02", { a: 200, b: 60, c: 30, d: 7 }),
];

const TAIL = ["c", "d"];

describe("withRollupSeries", () => {
  it("sums the hidden tail bands into one rollup series per bucket", () => {
    const rolled = withRollupSeries(DATA, TAIL, new Set(TAIL));
    expect(rolled.map((point) => point[ROLLUP_SERIES_KEY])).toEqual([25, 37]);
  });

  it("leaves the bands themselves untouched", () => {
    // They are still plotted; the rollup is an ADDITIONAL series, and the
    // hidden ones simply are not drawn.
    const rolled = withRollupSeries(DATA, TAIL, new Set(TAIL));
    expect(rolled[0].a).toBe(100);
    expect(rolled[0].c).toBe(20);
    expect(rolled[0].timestamp).toBe("00:01");
  });

  it("drops a band out of the rollup the moment it is shown", () => {
    // The point of the whole mechanism: switching a greyed-out ability on
    // moves it OUT of Other rather than drawing it on top of a rollup that
    // still contains it, so the stack's height never overstates the fight.
    const rolled = withRollupSeries(DATA, TAIL, new Set(["d"]));
    expect(rolled.map((point) => point[ROLLUP_SERIES_KEY])).toEqual([5, 7]);
  });

  it("keeps the stack summing to the fight however much of the tail is shown", () => {
    const whole = 100 + 50 + 20 + 5;
    for (const shown of [[], ["c"], ["d"], ["c", "d"]]) {
      const hidden = new Set(TAIL.filter((key) => !shown.includes(key)));
      const point = withRollupSeries(DATA, TAIL, hidden)[0];
      const drawn = ["a", "b", ...shown].reduce((sum, key) => sum + (point[key] ?? 0), 0);
      expect(drawn + (point[ROLLUP_SERIES_KEY] ?? 0)).toBe(whole);
    }
  });

  it("writes no rollup key at all when the whole tail is shown", () => {
    // A zeroed rollup band would still take a legend entry and a colour.
    const rolled = withRollupSeries(DATA, TAIL, new Set());
    expect(ROLLUP_SERIES_KEY in rolled[0]).toBe(false);
  });

  it("returns the data itself when there is no tail to roll up", () => {
    // Identity, not a copy: this runs on every hover re-render, and a fresh
    // array would re-reconcile the whole plot each time the pointer moved.
    expect(withRollupSeries(DATA, [], new Set())).toBe(DATA);
  });

  it("ignores a hidden band that is not part of the tail", () => {
    // Hiding a top band from the legend is a plain hide — it must not quietly
    // reappear inside Other, which would make the click look like it failed.
    const rolled = withRollupSeries(DATA, TAIL, new Set(["a", "c", "d"]));
    expect(rolled[0][ROLLUP_SERIES_KEY]).toBe(25);
  });

  it("counts a missing value as zero rather than as NaN", () => {
    // A band that accrued nothing late can arrive short of the others.
    const rolled = withRollupSeries([point("00:01", { c: 20 })], TAIL, new Set(TAIL));
    expect(rolled[0][ROLLUP_SERIES_KEY]).toBe(20);
  });
});

describe("rollupIsDrawn", () => {
  it("is true while any tail band is hidden", () => {
    expect(rollupIsDrawn(TAIL, new Set(["d"]))).toBe(true);
  });

  it("is false once the whole tail is shown", () => {
    expect(rollupIsDrawn(TAIL, new Set())).toBe(false);
  });

  it("is false on a chart with no tail at all", () => {
    expect(rollupIsDrawn([], new Set(["a"]))).toBe(false);
  });
});
