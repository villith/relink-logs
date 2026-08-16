import type { ChartMarker } from "./chartMarkers";

/** Every pane's chart markers on one plot, each tagged with the log it came
 * from — the marker half of `compareWindowTooltips`, and tagged for the same
 * reason: the overlay draws two fights, and a card row reading "Ferry —
 * Skybound Art" says nothing about which run cast it. The line itself cannot
 * say it (every SBA line wears one colour, by design), so the row does.
 *
 * Sorted by time across the panes, like `extractMarkers` sorts within one — the
 * chart buckets them either way, but a card listing one run's casts before the
 * other's would read as an ordering that is really just pane order. */
export const compareMarkers = (
  perPane: ChartMarker[][],
  tagOf: (paneIndex: number) => { text: string; color: string }
): ChartMarker[] =>
  perPane
    .flatMap((markers, paneIndex) => markers.map((marker) => ({ ...marker, tag: tagOf(paneIndex) })))
    .sort((a, b) => a.atMs - b.atMs);
