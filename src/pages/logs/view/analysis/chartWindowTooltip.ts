import type { ChartWindow } from "@/types";

import { DPS_BUCKET_MS } from "../DetailCharts";

import type { WindowKind } from "./chartWindowBands";

/** One hoverable window: the span the cursor can be inside (clipped and
 * rebased onto the chart window, like a band) and the finished tooltip line
 * (built from the window's TRUE full extent). */
export type WindowTooltipEntry = {
  kind: WindowKind;
  /** Chart-window-relative hover span, ms. */
  startMs: number;
  endMs: number;
  color: string;
  text: string;
};

/** The current tab's metric during `window`: every plotted series summed over
 * the window's buckets (start-inclusive, end-exclusive — a bucket belongs to
 * the window that contains its opening millisecond), scaled the way the chart
 * scales. The SERIES are already narrowed by every active filter (the backend
 * masks them), so this inherits the filters without knowing them. */
export const windowMetricAmount = (
  source: Record<string, number[]>,
  keys: (string | number)[],
  scale: number,
  window: { startMs: number; endMs: number }
): number => {
  const from = Math.max(0, Math.floor(window.startMs / DPS_BUCKET_MS));
  const upTo = Math.ceil(window.endMs / DPS_BUCKET_MS); // exclusive
  let total = 0;
  for (const key of keys) {
    const series = source[String(key)];
    if (!series) continue;
    for (let bucket = from; bucket < Math.min(upTo, series.length); bucket += 1) {
      total += series[bucket];
    }
  }
  return total * scale;
};

/** The chart's hoverable windows: each battle window overlapping the chart
 * window, its hover span clipped/rebased like a band, its text built by the
 * caller's lookups from the TRUE full extent. Zero-width clips are dropped —
 * a window touching the chart only at an edge covers no hoverable bucket. */
export const windowTooltipEntries = (
  windows: ChartWindow[],
  chartWindow: { startMs: number; endMs: number },
  amountOf: (window: ChartWindow) => number | null,
  labels: { text: (window: ChartWindow, amount: number | null) => string; color: (kind: WindowKind) => string }
): WindowTooltipEntry[] =>
  windows
    .filter((window) => window.startMs < chartWindow.endMs && window.endMs > chartWindow.startMs)
    .map((window) => ({
      kind: window.kind,
      startMs: Math.max(window.startMs, chartWindow.startMs) - chartWindow.startMs,
      endMs: Math.min(window.endMs, chartWindow.endMs) - chartWindow.startMs,
      color: labels.color(window.kind),
      text: labels.text(window, amountOf(window)),
    }))
    .filter((entry) => entry.endMs > entry.startMs);
