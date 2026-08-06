import type { ChartWindow } from "@/types";

import type { WireWindow } from "./auraWindows";
import { winFilterParts } from "./machine/state";

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

/** The wire mask for the selected windows: clipped to the scrub window,
 * merged, `[fromMs, upToMs)`. Empty is a REAL mask (matches nothing) — the
 * same convention `auraWireWindows` follows. */
export const windowFilterWireWindows = (
  selected: ChartWindow[],
  window: { startMs: number; endMs: number }
): WireWindow[] => {
  const clipped = selected
    .filter((span) => span.startMs < window.endMs && span.endMs > window.startMs)
    .map((span) => ({ fromMs: Math.max(span.startMs, window.startMs), upToMs: Math.min(span.endMs, window.endMs) }))
    .sort((a, b) => a.fromMs - b.fromMs);
  const merged: WireWindow[] = [];
  for (const span of clipped) {
    const last = merged[merged.length - 1];
    if (last && span.fromMs <= last.upToMs) last.upToMs = Math.max(last.upToMs, span.upToMs);
    else merged.push({ ...span });
  }
  return merged;
};

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
