import type { ChartWindow } from "@/types";

import { toBands, type Band } from "../statusBands";

/** The three battle-state windows the chart shades, in draw order. */
export const WINDOW_KINDS = ["sba", "link", "break"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

/** One shaded battle-state span, ready for the chart: the kind (for the
 * toggle row), its colour, and the clipped span. */
export type WindowBand = { kind: WindowKind; color: string; band: Band };

/** Colour per window kind. The same collision constraints as
 * `SBA_MARKER_COLOR` (chartMarkers.ts) apply — nothing here may read as a
 * party colour, the drag accent, or the Total grey — but bands draw as 16%
 * fills, not lines, so the harder rule is against EACH OTHER and their own
 * markers:
 *
 * - `sba` wears the SBA markers' grape ON PURPOSE: the marker is the window's
 *   opening edge, and one entity wears one hue.
 * - `link` takes indigo — cooler than the drag accent's cyan (`--color-accent`),
 *   which only ever appears mid-drag anyway.
 * - `break` takes orange: the "enemy is down, burn it" reading, and the only
 *   warm hue on the plot. */
export const WINDOW_BAND_COLOR: Record<WindowKind, string> = {
  sba: "var(--mantine-color-grape-4)",
  link: "var(--mantine-color-indigo-4)",
  break: "var(--mantine-color-orange-5)",
};

/** Control-row label per window kind (sibling of `MARKER_LABEL_KEY`). */
export const WINDOW_LABEL_KEY: Record<WindowKind, string> = {
  sba: "ui.logs.chart-window-sba",
  link: "ui.logs.chart-window-link",
  break: "ui.logs.chart-window-break",
};

/** The fight's battle-state windows as chart bands, clipped and rebased onto
 * the chart window through the SAME `toBands` the status shading uses — so a
 * window band and an aura band can never disagree about where a millisecond
 * falls. Per kind, so two enemies' overlapping Breaks merge into one span
 * while a Break and a Link Time overlay each other. */
export const windowBandsFor = (windows: ChartWindow[], chartWindow: { startMs: number; endMs: number }): WindowBand[] =>
  WINDOW_KINDS.flatMap((kind) =>
    toBands(
      windows.filter((span) => span.kind === kind),
      chartWindow
    ).map((band) => ({ kind, color: WINDOW_BAND_COLOR[kind], band }))
  );
