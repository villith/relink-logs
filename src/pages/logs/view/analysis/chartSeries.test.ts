import { describe, expect, it } from "vitest";

import { buildSeriesPoints, TOTAL_SERIES_KEY, withTotalSeries } from "./chartSeries";

describe("buildSeriesPoints", () => {
  it("plots string-keyed series, so a drill-down band is not forced into an actor index", () => {
    const points = buildSeriesPoints({
      source: { "group:normal-attack": [4, 6] },
      len: 2,
      keys: ["group:normal-attack"],
      smoothing: 1,
      scale: 1,
    });
    expect(points).toEqual([{ "group:normal-attack": 4 }, { "group:normal-attack": 6 }]);
  });

  it("keys each point by actor index, never by display label", () => {
    // Two players can share a label ("AI"), and a label-keyed point silently
    // overwrites one with the other.
    const points = buildSeriesPoints({
      source: { 7: [10, 20], 9: [1, 2] },
      len: 2,
      keys: [7, 9],
      smoothing: 1,
      scale: 1,
    });
    expect(points).toEqual([
      { "7": 10, "9": 1 },
      { "7": 20, "9": 2 },
    ]);
  });

  it("applies a trailing moving average over the smoothing window", () => {
    // Bucket 1 averages 0..1 -> 4.5, rounded to 5; bucket 2 averages 0..2 -> 6.
    const points = buildSeriesPoints({
      source: { 1: [3, 6, 9] },
      len: 3,
      keys: [1],
      smoothing: 3,
      scale: 1,
    });
    expect(points.map((p) => p["1"])).toEqual([3, 5, 6]);
  });

  it("averages over the buckets that exist, not the full window, at the start", () => {
    // Bucket 1 has only two buckets behind it: (3+6)/2 = 4.5 -> 5 rounded.
    const points = buildSeriesPoints({ source: { 1: [3, 6, 9] }, len: 2, keys: [1], smoothing: 5, scale: 1 });
    expect(points.map((p) => p["1"])).toEqual([3, 5]);
  });

  it("zeroes buckets outside the admitted mask instead of smearing the average past its edge", () => {
    // Buckets 4-5 are the bleed past a window filter's end: without the mask
    // the trailing average would decay across them, drawing damage after the
    // filter stopped admitting any.
    const points = buildSeriesPoints({
      source: { 1: [0, 0, 10, 10, 0, 0] },
      len: 6,
      keys: [1],
      smoothing: 3,
      scale: 1,
      admitted: [false, false, true, true, false, false],
    });
    // 10/3 and 20/3: the mask drops the excluded buckets' VALUES but not their
    // place in the window, so the line ramps in over the smoothing period.
    expect(points.map((p) => p["1"])).toEqual([0, 0, 3, 7, 0, 0]);
  });

  it("keeps the excluded buckets in the denominator, so a mask can never raise the rate", () => {
    // The plotted Y is a rate per WALL-CLOCK bucket. Dividing by the admitted
    // count instead would rescale it to a rate per admitted bucket and multiply
    // the leading edge of every admitted region by up to `smoothing` — a filter
    // that removes time but no damage would make DPS go UP (log #1880: an aura
    // that excluded 0.13% of the damage doubled the plotted peak).
    const source = { 1: [99, 99, 6, 12] };
    const masked = buildSeriesPoints({
      source,
      len: 4,
      keys: [1],
      smoothing: 3,
      scale: 1,
      admitted: [false, false, true, true],
    });
    // Bucket 3's window is 1..3 and holds 6+12 of admitted damage: 18/3 = 6.
    expect(masked.map((p) => p["1"])).toEqual([0, 0, 2, 6]);

    // The invariant that failure violated: masking narrows a series, never
    // widens it, at every bucket.
    const whole = buildSeriesPoints({ source, len: 4, keys: [1], smoothing: 3, scale: 1 });
    masked.forEach((point, bucket) => expect(point["1"]).toBeLessThanOrEqual(whole[bucket]["1"]));
  });

  it("leaves an unmasked series byte-identical, so only filtered charts move", () => {
    const source = { 1: [3, 6, 9, 12] };
    const args = { source, len: 4, keys: [1], smoothing: 3, scale: 1 };
    expect(buildSeriesPoints({ ...args, admitted: [true, true, true, true] })).toEqual(buildSeriesPoints(args));
  });

  it("scales stored values, so an SBA gauge stored in tenths reads as a percent", () => {
    const points = buildSeriesPoints({ source: { 1: [850, 1000] }, len: 2, keys: [1], smoothing: 1, scale: 0.1 });
    expect(points.map((p) => p["1"])).toEqual([85, 100]);
  });

  it("treats a player with no series as zero rather than dropping the key", () => {
    // A row that exists in the party but not in this metric's chart must still
    // be plotted, or the legend declares a series the data has no key for.
    const points = buildSeriesPoints({ source: { 1: [5] }, len: 1, keys: [1, 2], smoothing: 1, scale: 1 });
    expect(points).toEqual([{ "1": 5, "2": 0 }]);
  });

  it("returns nothing when the metric has no buckets", () => {
    expect(buildSeriesPoints({ source: {}, len: 0, keys: [1], smoothing: 1, scale: 1 })).toEqual([]);
  });
});

describe("withTotalSeries", () => {
  it("sums every listed series per bucket", () => {
    const points = withTotalSeries(
      [
        { "0": 100, "1": 50 },
        { "0": 0, "1": 25 },
      ],
      ["0", "1"]
    );
    expect(points).toEqual([
      { "0": 100, "1": 50, [TOTAL_SERIES_KEY]: 150 },
      { "0": 0, "1": 25, [TOTAL_SERIES_KEY]: 25 },
    ]);
  });

  it("counts a key the point lacks as zero", () => {
    // The legend declares one series per player, and a key the data lacks
    // plots as a gap — the Total must not become NaN over it.
    const points = withTotalSeries([{ "0": 10 }], ["0", "9"]);
    expect(points[0][TOTAL_SERIES_KEY]).toBe(10);
  });

  it("accepts numeric keys, matching buildSeriesPoints' key union", () => {
    const points = withTotalSeries([{ "7": 3 }], [7]);
    expect(points[0][TOTAL_SERIES_KEY]).toBe(3);
  });
});
