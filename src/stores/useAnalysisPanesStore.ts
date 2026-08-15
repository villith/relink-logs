import { create } from "zustand";

import type { EncounterStateResponse } from "./useEncounterStore";

/** What one pane has in hand for its log.
 *
 * `base` is the unpinned load — charts, party, target entries, status
 * intervals, quest metadata; nothing a pin changes. `scoped` is everything the
 * pins, window, grouping and masks re-derive. Both are null until their fetch
 * lands, and both are dropped the moment the pane's log changes: a pane drawing
 * the previous log's charts under the new log's name is the one failure this
 * store exists to prevent. */
export type PaneSlice = {
  logId: number;
  base: EncounterStateResponse | null;
  scoped: EncounterStateResponse | null;
  /** What this pane's plot comes to per bucket, published for the FRAME to
   * overlay one line per log. The pane resolves it, because deciding what a
   * plot totals is the chart model's job and there is one of those per pane.
   * Empty until the pane has drawn something. */
  chart: PaneChart;
};

/** One pane's plot, flattened for the compare overlay: the per-bucket totals
 * and the axis format they are read in. The format rides along because every
 * pane shares the metric, so one is the whole overlay's — and reading it off
 * the panes keeps the frame from spelling out a rule the chart model owns. */
export type PaneChart = {
  totals: number[];
  format: "amount" | "percent" | "count";
};

const EMPTY_PANE_CHART: PaneChart = { totals: [], format: "amount" };

type AnalysisPanesState = {
  /** Ordered: pane 0 is the log in the path, the rest are the comparisons.
   * A LIST, not a fixed pair — the UI ships two, the model permits any number
   * (see the spec's "out of scope"). */
  panes: PaneSlice[];
  /** Reconcile the pane list against the URL. Panes keep their data when their
   * log is unchanged and lose it when it is not. */
  setPaneLogs: (logIds: number[]) => void;
  setPaneBase: (index: number, response: EncounterStateResponse) => void;
  setPaneScoped: (index: number, response: EncounterStateResponse | null) => void;
  setPaneChart: (index: number, chart: PaneChart) => void;
};

const writeAt = (panes: PaneSlice[], index: number, change: (pane: PaneSlice) => PaneSlice): PaneSlice[] =>
  // A response can outlive the pane that asked for it — the user removes a
  // comparison while its fetch is in flight. Dropping the write is correct;
  // growing the list to fit it would resurrect a closed pane.
  index < 0 || index >= panes.length ? panes : panes.map((pane, at) => (at === index ? change(pane) : pane));

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
          : { logId, base: null, scoped: null, chart: EMPTY_PANE_CHART };
      }),
    })),
  setPaneBase: (index, response) =>
    set((state) => ({
      // A landing base load answers the whole fight, so it also retires
      // whatever the previous pins had scoped — the same reset the single-log
      // view does today when its base load resolves.
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, base: response, scoped: null })),
    })),
  setPaneScoped: (index, response) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, scoped: response })),
    })),
  setPaneChart: (index, chart) =>
    set((state) => ({
      panes: writeAt(state.panes, index, (pane) => ({ ...pane, chart })),
    })),
}));
