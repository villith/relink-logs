import { describe, expect, it } from "vitest";

import type { ChartDatapoint, Label } from "../DetailCharts";

import { TOTAL_SERIES_KEY } from "./chartSeries";
import { compareChartData, compareSeriesKey, paneTotals } from "./compareSeries";

const labels: Label = [
  { name: "0", partySlotIndex: 0, color: "blue" },
  { name: "1", partySlotIndex: 1, color: "red" },
];

const bucketLabel = (bucket: number) => `0:0${bucket}`;

describe("compareSeriesKey", () => {
  it("keys a series by its pane, not by its log — one log can fill two panes", () => {
    expect(compareSeriesKey(0)).toBe("pane0");
    expect(compareSeriesKey(1)).toBe("pane1");
  });
});

describe("paneTotals", () => {
  it("sums the plotted series, bucket by bucket", () => {
    const data = [
      { timestamp: "0:00", "0": 10, "1": 5 },
      { timestamp: "0:01", "0": 2, "1": 3 },
    ] as unknown as ChartDatapoint[];

    expect(paneTotals(data, labels)).toEqual([15, 5]);
  });

  // The chart bakes its own Total series into the points on the tabs that plot
  // one. Summing the series AND that total would double every reading.
  it("takes the chart's own Total series where the points carry one", () => {
    const data = [{ timestamp: "0:00", "0": 10, "1": 5, [TOTAL_SERIES_KEY]: 15 }] as unknown as ChartDatapoint[];

    expect(paneTotals(data, labels)).toEqual([15]);
  });

  it("treats a series absent from a bucket as nothing, not as a hole", () => {
    const data = [{ timestamp: "0:00", "0": 10 }] as unknown as ChartDatapoint[];

    expect(paneTotals(data, labels)).toEqual([10]);
  });

  it("is empty for a pane with nothing plotted yet", () => {
    expect(paneTotals([], labels)).toEqual([]);
  });
});

describe("compareChartData", () => {
  it("puts each pane's totals on its own series", () => {
    const data = compareChartData(
      [
        [10, 20],
        [5, 6],
      ],
      bucketLabel
    );

    expect(data).toEqual([
      { timestamp: "0:00", pane0: 10, pane1: 5 },
      { timestamp: "0:01", pane0: 20, pane1: 6 },
    ]);
  });

  // Absent, not zero: zero would draw a line along the floor and read as "did
  // nothing" rather than "the run was over".
  it("spans the LONGEST run, leaving the shorter series absent past its end", () => {
    const data = compareChartData([[1, 2, 3], [9]], bucketLabel);

    expect(data).toHaveLength(3);
    expect(data[2]).toEqual({ timestamp: "0:02", pane0: 3 });
    expect(data[1].pane1).toBeUndefined();
  });

  it("is empty when no pane has data yet", () => {
    expect(compareChartData([[], []], bucketLabel)).toEqual([]);
  });
});
