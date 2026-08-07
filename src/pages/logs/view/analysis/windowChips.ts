import type { ChartWindow } from "@/types";

import { WINDOW_KINDS, type WindowKind } from "./chartWindowBands";

export type WindowChip = {
  /** The `win` filter value this chip selects (`sba` or `sba:1`). */
  value: string;
  label: string;
  /** The window's own length ("22s"); the kind chip carries none (its count
   * is in the label). */
  durationLabel: string | null;
  kind: WindowKind;
  /** The kind's own translated name ("SBA windows"), for a per-window chip's
   * `aria-label` — its visible `label` is a bare range ("10-20") that names no
   * kind on its own. A kind chip needs none: its visible label already names
   * the kind. */
  kindLabel: string;
  selected: boolean;
};

/** Name lookups injected so the builder stays pure of i18n and actor naming. */
export type WindowChipLabels = {
  kindLabel: (kind: WindowKind) => string;
  kindChipLabel: (kindLabel: string, count: number) => string;
  rangeLabel: (startMs: number, endMs: number) => string;
  durationLabel: (ms: number) => string;
  /** The breaking enemy's display name, or null when unresolvable. Receives
   * the whole window so the lookup can match on time overlap — the game
   * reissues a dead boss's actor index, so the index alone could name the
   * wrong spawn. */
  breakEnemyLabel: (actorIndex: number | null, window: ChartWindow) => string | null;
};

/** The Windows strip's chips: per kind present, one "all of the kind" chip
 * then one chip per window in start order — the same 0-based per-kind order
 * `selectedChartWindows` resolves an individual index against. */
export const windowChips = (windows: ChartWindow[], win: string | null, labels: WindowChipLabels): WindowChip[] =>
  WINDOW_KINDS.flatMap((kind) => {
    const ofKind = windows.filter((span) => span.kind === kind).sort((a, b) => a.startMs - b.startMs);
    if (ofKind.length === 0) return [];
    const kindLabel = labels.kindLabel(kind);
    return [
      {
        value: kind as string,
        label: labels.kindChipLabel(kindLabel, ofKind.length),
        durationLabel: null,
        kind,
        kindLabel,
        selected: win === kind,
      },
      ...ofKind.map((span, index) => {
        const enemy = kind === "break" ? labels.breakEnemyLabel(span.actorIndex, span) : null;
        const range = labels.rangeLabel(span.startMs, span.endMs);
        return {
          value: `${kind}:${index}`,
          label: enemy === null ? range : `${enemy} ${range}`,
          durationLabel: labels.durationLabel(span.endMs - span.startMs),
          kind,
          kindLabel,
          selected: win === `${kind}:${index}`,
        };
      }),
    ];
  });
