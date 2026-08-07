import type { ChartWindow } from "@/types";

import { clampToWindow, overlapsWindow } from "../spans";

import { winFilterParts } from "./machine/state";
import type { WireWindow } from "./wireWindows";

/** The battle windows a `win` filter value names, in start order. A stale
 * individual index (the log reparsed into fewer windows) selects NOTHING —
 * the same "narrows, never widens" rule stale target pins follow. */
export const selectedChartWindows = (windows: ChartWindow[], win: string): ChartWindow[] => {
  const { kind, index } = winFilterParts(win);
  const ofKind = windows.filter((span) => span.kind === kind).sort((a, b) => a.startMs - b.startMs);
  if (index === null) return ofKind;
  const one = ofKind[index];
  return one === undefined ? [] : [one];
};

/** The scrub range (inclusive bucket indexes) covering the selected windows'
 * hull — what a window chip commits so the chart zooms to the selection. The
 * end bucket is the last one holding admitted time, so an end exactly on a
 * bucket edge claims nothing of the next bucket. Null when the selection
 * resolves to no windows (a stale index): nothing to zoom to. */
export const windowFilterScrubRange = (selected: ChartWindow[], bucketMs: number): [number, number] | null => {
  if (selected.length === 0) return null;
  const startMs = Math.min(...selected.map((span) => span.startMs));
  const endMs = Math.max(...selected.map((span) => span.endMs));
  const first = Math.floor(startMs / bucketMs);
  return [first, Math.max(first, Math.ceil(endMs / bucketMs) - 1)];
};

/** Which chart buckets the mask admits — a bucket counts as admitted when any
 * span overlaps it, partial overlap included (the span convention is
 * `[fromMs, upToMs)`, so a span ending exactly on a bucket edge does not
 * admit the next bucket). Feeds `buildSeriesPoints`' mask-aware smoothing. */
export const admittedBucketsOf = (mask: WireWindow[], len: number, bucketMs: number): boolean[] =>
  Array.from({ length: len }, (_, bucket) =>
    mask.some((span) => span.fromMs < (bucket + 1) * bucketMs && span.upToMs > bucket * bucketMs)
  );

/** Status intervals clipped to the mask, for the status TABLES. Each piece
 * keeps the interval's payload, but `applications` is counted ONLY in the
 * span containing the interval's start — the apply moment — so a buff
 * crossing three admitted spans still counts once, and one applied outside
 * the mask entirely counts zero. (Refreshes folded into `applications`
 * cannot be re-dated, so start-attribution is the honest approximation.) */
export const maskStatusIntervals = <T extends { startMs: number; endMs: number; applications: number }>(
  intervals: T[],
  mask: WireWindow[]
): T[] =>
  mask.flatMap((span) => {
    // Clipped one span at a time rather than through `clipSpans`, because the
    // applications test needs the interval's ORIGINAL start: an interval
    // starting exactly on the span's edge was applied inside it, and after
    // clamping that is indistinguishable from one clipped down to the edge.
    const window = { startMs: span.fromMs, endMs: span.upToMs };
    return intervals
      .filter((interval) => overlapsWindow(interval, window))
      .map((interval) => ({
        ...clampToWindow(interval, window),
        applications: interval.startMs >= window.startMs ? interval.applications : 0,
      }));
  });

/** Time inside BOTH masks — the aura filter and the window filter compose by
 * intersection. Both inputs sorted and merged (what the two builders return). */
export const intersectWireWindows = (a: WireWindow[], b: WireWindow[]): WireWindow[] => {
  const out: WireWindow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const fromMs = Math.max(a[i].fromMs, b[j].fromMs);
    const upToMs = Math.min(a[i].upToMs, b[j].upToMs);
    if (fromMs < upToMs) out.push({ fromMs, upToMs });
    if (a[i].upToMs <= b[j].upToMs) i += 1;
    else j += 1;
  }
  return out;
};
