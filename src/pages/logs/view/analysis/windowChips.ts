import type { ChartWindow } from "@/types";

import { WINDOW_KINDS, type WindowKind } from "./chartWindowBands";

/** One individual battle window, as a row of its kind's menu. */
export type WindowChipItem = {
  /** The `win` filter value this row toggles (`sba:1`). */
  value: string;
  /** The window's range ("0:12–0:34"), the breaking enemy's name in front of
   * it where there is one. */
  label: string;
  /** The window's own length ("22s"). */
  durationLabel: string;
  selected: boolean;
};

/** One kind of battle window, as a chip that opens a menu.
 *
 * The strip used to flatten these — a kind chip followed by every one of its
 * windows, inline — which put a whole fight's SBA, Link and Break windows in
 * one wrapping row between the chart and the table. The kinds are the level a
 * reader chooses at; the individual windows belong behind the chip that names
 * them. */
export type WindowChipGroup = {
  kind: WindowKind;
  /** The kind's own translated name ("SBA windows") — the chip's caption and
   * the menu's accessible name. */
  kindLabel: string;
  /** The `win` value standing for the whole kind (`sba`). */
  allValue: string;
  /** Whether the "all of this kind" row is ticked. */
  allSelected: boolean;
  items: WindowChipItem[];
  /** How many of this kind's windows the selection admits — every one of them
   * while `allSelected`, whatever the individual rows say. */
  selectedCount: number;
  /** Whether this kind contributes anything to the filter at all. */
  active: boolean;
  /** The figure after the chip's label: the selected-of-total count while the
   * selection is PARTIAL, the bare total otherwise. A chip reading "2/4" when
   * all four are picked would suggest something was left out; one reading
   * "×4" while two are picked would hide the filter that is running. */
  figure: string;
};

/** Name and count lookups injected so the builder stays pure of i18n and actor
 * naming. */
export type WindowChipLabels = {
  kindLabel: (kind: WindowKind) => string;
  /** The bare total ("×4"), for a kind with nothing or everything picked. */
  totalLabel: (count: number) => string;
  /** The partial count ("2/4"). */
  selectedLabel: (selected: number, total: number) => string;
  rangeLabel: (startMs: number, endMs: number) => string;
  durationLabel: (ms: number) => string;
  /** The breaking enemy's display name, or null when unresolvable. Receives
   * the whole window so the lookup can match on time overlap — the game
   * reissues a dead boss's actor index, so the index alone could name the
   * wrong spawn. */
  breakEnemyLabel: (actorIndex: number | null, window: ChartWindow) => string | null;
};

/** The Windows strip's chips: one per kind PRESENT in the fight, each carrying
 * its own windows in start order — the same 0-based per-kind order
 * `selectedChartWindows` resolves an individual index against. */
export const windowChips = (windows: ChartWindow[], win: string[], labels: WindowChipLabels): WindowChipGroup[] => {
  const selected = new Set(win);
  return WINDOW_KINDS.flatMap((kind) => {
    const ofKind = windows.filter((span) => span.kind === kind).sort((a, b) => a.startMs - b.startMs);
    if (ofKind.length === 0) return [];

    const allSelected = selected.has(kind as string);
    const items = ofKind.map((span, index) => {
      // Overdrive windows carry a per-enemy actor index exactly like Break's.
      const enemy = kind === "break" || kind === "overdrive" ? labels.breakEnemyLabel(span.actorIndex, span) : null;
      const range = labels.rangeLabel(span.startMs, span.endMs);
      return {
        value: `${kind}:${index}`,
        label: enemy === null ? range : `${enemy} ${range}`,
        durationLabel: labels.durationLabel(span.endMs - span.startMs),
        selected: selected.has(`${kind}:${index}`),
      };
    });

    // The kind row admits everything, so it wins over the individual ticks
    // rather than summing with them — "all four" and "all four plus #2" name
    // the same four windows.
    const selectedCount = allSelected ? items.length : items.filter((item) => item.selected).length;
    const partial = selectedCount > 0 && selectedCount < items.length;

    return [
      {
        kind,
        kindLabel: labels.kindLabel(kind),
        allValue: kind as string,
        allSelected,
        items,
        selectedCount,
        active: selectedCount > 0,
        figure: partial ? labels.selectedLabel(selectedCount, items.length) : labels.totalLabel(items.length),
      },
    ];
  });
};
