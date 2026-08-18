import { WINDOW_KINDS, type WindowBand } from "./chartWindowBands";
import type { WindowTooltipEntry } from "./chartWindowTooltip";

/** One pane's battle-state windows, as its own chart would have drawn them —
 * published for the frame's single-chart overlay, which has no fight of its own
 * to read them from. Both halves are already clipped and rebased onto the chart
 * window by the pane (see `windowBandsFor` / `windowTooltipEntries`), and the
 * window is a SHARED field, so two panes' spans stand on one axis. */
export type PaneWindows = {
  bands: WindowBand[];
  tooltips: WindowTooltipEntry[];
};

export const EMPTY_PANE_WINDOWS: PaneWindows = { bands: [], tooltips: [] };

/** Every pane's window bands on one plot, still coloured BY KIND.
 *
 * Walked kind-first rather than pane-first so the draw order stays the one
 * `windowBandsFor` establishes for a single log — the fills are translucent, and
 * where two runs were in the same state at the same second the overlap simply
 * shades harder, which is the reading: both runs were there.
 *
 * Deliberately NOT merged into one span per kind. Two logs' Breaks are two
 * facts, not one longer Break, and the hover card names which run each belongs
 * to (see `compareWindowTooltips`). */
export const compareWindowBands = (perPane: WindowBand[][]): WindowBand[] =>
  WINDOW_KINDS.flatMap((kind) => perPane.flatMap((bands) => bands.filter((band) => band.kind === kind)));

/** Every pane's hoverable windows, each line tagged with the log it came from.
 *
 * Untagged, two runs' Breaks read as one run's four: the span text says when and
 * for how long, and nothing in it says whose. The tag rather than a prefix
 * inside the text, because the row's own swatch is the KIND's colour — it has
 * to be, the card groups these under one heading per kind — so the log can only
 * be told apart by an id that wears its line's colour itself. */
export const compareWindowTooltips = (
  perPane: WindowTooltipEntry[][],
  tagOf: (paneIndex: number) => { text: string; color: string }
): WindowTooltipEntry[] =>
  perPane.flatMap((entries, paneIndex) => entries.map((entry) => ({ ...entry, tag: tagOf(paneIndex) })));
