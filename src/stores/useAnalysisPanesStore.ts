import { create } from "zustand";

import type { LabelledOption } from "@/pages/logs/view/analysis/PinSelect";
import type { ChartMarker } from "@/pages/logs/view/analysis/chartMarkers";
import { EMPTY_PANE_WINDOWS, type PaneWindows } from "@/pages/logs/view/analysis/compareWindows";

import type { EncounterStateResponse } from "./useEncounterStore";

/** What one pane has in hand for its log.
 *
 * `base` is the unpinned load — charts, party, target entries, status
 * intervals, quest metadata; nothing a pin changes. It is null until its fetch
 * lands, and is dropped the moment the pane's log changes: a pane drawing the
 * previous log's charts under the new log's name is the one failure this store
 * exists to prevent. What the pins, window, grouping and masks re-derive stays
 * in the pane's own `useEncounterData` — the frame reads `chart` and `sources`,
 * which the pane publishes already resolved. */
export type PaneSlice = {
  logId: number;
  base: EncounterStateResponse | null;
  /** What this pane's plot comes to per bucket, published for the FRAME to
   * overlay one line per log. The pane resolves it, because deciding what a
   * plot totals is the chart model's job and there is one of those per pane.
   * Empty until the pane has drawn something. */
  chart: PaneChart;
  /** This pane's source universe and its current pin, published for the FRAME's
   * shared source bar — one selector per log, so a comparison picks one source
   * from each. Empty until the pane's fetch has told it who is in the fight. */
  sources: PaneSources;
  /** This pane's battle-state windows, published for the FRAME's single-chart
   * overlay: that plot draws one line per log and has no fight of its own, so
   * the SBA/Link/Overdrive/Break shading has to come from the panes. Resolved
   * here for the same reason `chart` is — clipping a window onto the chart
   * window is the chart model's job, and there is one of those per pane. */
  windows: PaneWindows;
  /** This pane's death and SBA-cast markers, published for the overlay for the
   * same reason `windows` is. An SBA window says a Skybound Art was being
   * performed; these say who cast each one and when, which is the reading a
   * chain of four does not survive being merged into one span. */
  markers: ChartMarker[];
};

/** One pane's source selector, as the frame draws it.
 *
 * `onChange` is the PANE's own handler, published rather than reimplemented in
 * the frame: pinning a source is a machine transition that also drops the
 * grouping override and arms the auto-drill, and a second spelling of that in
 * the frame is exactly how the bar and a row click would come to mean two
 * different things. It is identity-STABLE (a ref-backed wrapper, see
 * `AnalysisPane`), so publishing it cannot loop the frame. */
export type PaneSources = {
  options: LabelledOption[];
  /** The pinned actor index, or null for the whole party. */
  value: number | null;
  onChange: (index: number | null) => void;
};

const NO_SOURCES: PaneSources = { options: [], value: null, onChange: () => {} };

/** One pane's plot, flattened for the compare overlay: the per-bucket totals
 * and the axis format they are read in. The format rides along because every
 * pane shares the metric, so one is the whole overlay's — and reading it off
 * the panes keeps the frame from spelling out a rule the chart model owns. */
export type PaneChart = {
  totals: number[];
  format: "amount" | "percent" | "count";
};

const EMPTY_PANE_CHART: PaneChart = { totals: [], format: "amount" };

const NO_MARKERS: ChartMarker[] = [];

type AnalysisPanesState = {
  /** Ordered: pane 0 is the log in the path, the rest are the comparisons.
   * A LIST, not a fixed pair — the UI ships two, the model permits any number
   * (see the spec's "out of scope"). */
  panes: PaneSlice[];
  /** Reconcile the pane list against the URL. Panes keep their data when their
   * log is unchanged and lose it when it is not. */
  setPaneLogs: (logIds: number[]) => void;
  /** A landed fetch. `logId` is the log it ASKED for, and the write is dropped
   * unless the pane at `index` is still showing it — see `writeAt`. */
  setPaneBase: (index: number, logId: number, response: EncounterStateResponse) => void;
  setPaneChart: (index: number, chart: PaneChart) => void;
  setPaneSources: (index: number, sources: PaneSources) => void;
  setPaneWindows: (index: number, windows: PaneWindows) => void;
  setPaneMarkers: (index: number, markers: ChartMarker[]) => void;
};

const writeAt = (panes: PaneSlice[], index: number, change: (pane: PaneSlice) => PaneSlice): PaneSlice[] =>
  // A response can outlive the pane that asked for it — the user removes a
  // comparison while its fetch is in flight. Dropping the write is correct;
  // growing the list to fit it would resurrect a closed pane.
  index < 0 || index >= panes.length ? panes : panes.map((pane, at) => (at === index ? change(pane) : pane));

/** `writeAt`, but only when the slice is still showing the log the write
 * answers for.
 *
 * The range check alone is not enough for FETCHED data: the indexes are
 * positional and get reused, so closing a comparison whose fetch is in flight
 * and then opening another puts a live pane back at that index — and the dead
 * pane's response then lands on it, because the `useEncounterData` instance
 * holding the generation ref that would have vetoed it unmounted with the pane.
 * The slice itself carries what the response has to match. */
const writeAtLog = (
  panes: PaneSlice[],
  index: number,
  logId: number,
  change: (pane: PaneSlice) => PaneSlice
): PaneSlice[] => writeAt(panes, index, (pane) => (pane.logId === logId ? change(pane) : pane));

export const useAnalysisPanesStore = create<AnalysisPanesState>((set) => ({
  panes: [],
  setPaneLogs: (logIds) =>
    set((state) => ({
      // Matched by POSITION, not by log id: two panes may carry the same log
      // down two different drill paths, and keying by id would hand them one
      // slice and one set of fetched data.
      panes: logIds.map((logId, index) => {
        const existing = state.panes[index];
        return existing !== undefined && existing.logId === logId
          ? existing
          : {
              logId,
              base: null,
              chart: EMPTY_PANE_CHART,
              sources: NO_SOURCES,
              windows: EMPTY_PANE_WINDOWS,
              markers: NO_MARKERS,
            };
      }),
    })),
  setPaneBase: (index, logId, response) =>
    set((state) => ({
      panes: writeAtLog(state.panes, index, logId, (pane) => ({ ...pane, base: response })),
    })),
  setPaneChart: (index, chart) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, chart })),
    })),
  setPaneSources: (index, sources) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, sources })),
    })),
  setPaneWindows: (index, windows) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, windows })),
    })),
  setPaneMarkers: (index, markers) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, markers })),
    })),
}));
