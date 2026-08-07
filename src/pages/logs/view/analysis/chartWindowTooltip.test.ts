import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { windowMetricAmount, windowTooltipEntries } from "./chartWindowTooltip";

const WINDOWS: ChartWindow[] = [
  { kind: "sba", startMs: 2_000, endMs: 6_000, actorIndex: null },
  { kind: "link", startMs: 90_000, endMs: 95_000, actorIndex: null },
];

describe("windowMetricAmount", () => {
  const source = { a: [0, 100, 200, 300, 400, 500], b: [0, 10, 20, 30, 40, 50] };

  it("sums every plotted series over the window's buckets, scaled", () => {
    // [2000, 6000) covers buckets 2..5 (start-inclusive, end-exclusive).
    expect(windowMetricAmount(source, ["a", "b"], 1, WINDOWS[0])).toBe(200 + 300 + 400 + 500 + 20 + 30 + 40 + 50);
  });

  it("clamps to the series length", () => {
    expect(windowMetricAmount({ a: [100, 100] }, ["a"], 1, { ...WINDOWS[0], startMs: 0, endMs: 99_000 })).toBe(200);
  });

  it("applies the chart's scale", () => {
    expect(windowMetricAmount({ a: [0, 0, 10, 10, 10, 10] }, ["a"], 0.5, WINDOWS[0])).toBe(20);
  });
});

describe("windowTooltipEntries", () => {
  const labels = {
    text: (window: ChartWindow, amount: number | null) =>
      `${window.kind} ${window.startMs}-${window.endMs}${amount === null ? "" : ` ${amount}`}`,
    color: () => "grape",
  };

  it("clips hoverable spans to the chart window but keeps full-extent text", () => {
    const entries = windowTooltipEntries(WINDOWS, { startMs: 4_000, endMs: 100_000 }, () => 123, labels);
    expect(entries).toHaveLength(2);
    // Hover span rebased onto the chart window…
    expect(entries[0].startMs).toBe(0);
    expect(entries[0].endMs).toBe(2_000);
    // …but the text reports the window's TRUE extent and amount.
    expect(entries[0].text).toBe("sba 2000-6000 123");
  });

  it("drops windows outside the chart window entirely", () => {
    const entries = windowTooltipEntries(WINDOWS, { startMs: 10_000, endMs: 80_000 }, () => null, labels);
    expect(entries).toHaveLength(0);
  });
});
