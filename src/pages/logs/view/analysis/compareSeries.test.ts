import { describe, expect, it } from "vitest";

import type { LogSummary } from "@/types";
import { epochToLocalTime } from "@/utils";

import type { ChartDatapoint, Label } from "../DetailCharts";

import { TOTAL_SERIES_KEY } from "./chartSeries";
import {
  compareChartData,
  compareSeriesKey,
  paneSeriesColor,
  paneSeriesLabels,
  paneSeriesShortLabel,
  paneTotals,
} from "./compareSeries";

const labels: Label = [
  { name: "0", partySlotIndex: 0, color: "blue" },
  { name: "1", partySlotIndex: 1, color: "red" },
];

const bucketLabel = (bucket: number) => `0:0${bucket}`;

const summary = (id: number, time: number): LogSummary =>
  ({ id, time, duration: 1000, questId: null, questElapsedTime: null, repeatGroup: null }) as LogSummary;

describe("compareSeriesKey", () => {
  it("keys a series by its pane, not by its log — one log can fill two panes", () => {
    expect(compareSeriesKey(0)).toBe("pane0");
    expect(compareSeriesKey(1)).toBe("pane1");
  });
});

/** A hex colour's hue in degrees — enough to say which family it is in. */
const hueOf = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const span = max - min;
  const raw = max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span;
  return (raw * 60 + 360) % 360;
};

describe("paneSeriesColor", () => {
  // A whole column tinted red or amber reads as an error or a warning about that
  // log, which is what every other red/amber mark in this app means. Asserted on
  // the HUE rather than on the literals, so a future palette edit has to answer
  // for it too.
  it("never draws a log in a warning colour", () => {
    const hues = Array.from({ length: 8 }, (_, paneIndex) => hueOf(paneSeriesColor(paneIndex)));

    expect(hues.filter((hue) => hue < 66 || hue > 330)).toEqual([]);
  });

  it("gives the first two panes colours that stay apart", () => {
    expect(Math.abs(hueOf(paneSeriesColor(0)) - hueOf(paneSeriesColor(1)))).toBeGreaterThan(60);
  });

  // The model permits any number of panes; the palette is finite.
  it("wraps rather than running out", () => {
    expect(paneSeriesColor(8)).toBe(paneSeriesColor(0));
  });
});

describe("paneSeriesLabels", () => {
  // Two runs of one quest are told apart by WHEN they were run; a database id is
  // a number nobody recognises.
  it("names a run by its id and when it happened", () => {
    const log = summary(12, 1_760_000_000_000);

    expect(paneSeriesLabels([12], [log])).toEqual([`#12 · ${epochToLocalTime(log.time)}`]);
  });

  it("keeps one entry per pane, in pane order", () => {
    const logs = [summary(12, 1_760_000_000_000), summary(7, 1_750_000_000_000)];

    expect(paneSeriesLabels([7, 12], logs)).toEqual([
      `#7 · ${epochToLocalTime(logs[1].time)}`,
      `#12 · ${epochToLocalTime(logs[0].time)}`,
    ]);
  });

  // The library load is a fetch of its own, and a bookmarked URL can name a
  // deleted run. The id alone still says which log the line is, where an empty
  // label would leave the series nameless.
  it("falls back to the bare id for a log the library has not handed over", () => {
    expect(paneSeriesLabels([12], [])).toEqual(["#12"]);
  });
});

describe("paneSeriesShortLabel", () => {
  // Drawn inside the plot, at the rule's own x — the legend above it carries the
  // date in the same colour.
  it("is the id alone, for a label that has to fit on the plot", () => {
    expect(paneSeriesShortLabel(12)).toBe("#12");
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
