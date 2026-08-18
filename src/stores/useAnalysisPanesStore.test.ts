import { beforeEach, describe, expect, it } from "vitest";

import { useAnalysisPanesStore } from "./useAnalysisPanesStore";

const reset = () => useAnalysisPanesStore.setState({ panes: [] });

describe("useAnalysisPanesStore", () => {
  beforeEach(reset);

  it("holds a slice per pane, in pane order", () => {
    const { setPaneLogs } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2661]);
    expect(useAnalysisPanesStore.getState().panes.map((pane) => pane.logId)).toEqual([2657, 2661]);
  });

  it("keeps a pane's fetched data when an unrelated pane changes log", () => {
    const { setPaneLogs, setPaneBase } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2661]);
    setPaneBase(0, 2657, { chartLen: 42 } as never);
    useAnalysisPanesStore.getState().setPaneLogs([2657, 2664]);
    expect(useAnalysisPanesStore.getState().panes[0].base).toEqual({ chartLen: 42 });
  });

  it("drops the fetched data of a pane whose log changed, so no pane draws another log", () => {
    const { setPaneLogs, setPaneBase } = useAnalysisPanesStore.getState();
    setPaneLogs([2657]);
    setPaneBase(0, 2657, { chartLen: 42 } as never);
    useAnalysisPanesStore.getState().setPaneLogs([2661]);
    expect(useAnalysisPanesStore.getState().panes[0].base).toBeNull();
  });

  // Two panes on ONE log is a real comparison (the same run down two drill
  // paths), so the slices have to stay distinct rather than share by log id.
  it("gives two panes on the same log separate slices", () => {
    const { setPaneLogs, setPaneBase } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2657]);
    setPaneBase(0, 2657, { chartLen: 42 } as never);
    const panes = useAnalysisPanesStore.getState().panes;
    expect(panes[1].base).toBeNull();
    expect(panes[0].base).toEqual({ chartLen: 42 });
  });

  // The frame overlays one line per pane from these, so a pane still carrying
  // the previous log's plot would draw that log's line under the new one's name.
  it("drops a pane's published plot when its log changed", () => {
    const { setPaneLogs, setPaneChart } = useAnalysisPanesStore.getState();
    setPaneLogs([2657]);
    setPaneChart(0, { totals: [1, 2, 3], format: "amount" });
    useAnalysisPanesStore.getState().setPaneLogs([2661]);
    expect(useAnalysisPanesStore.getState().panes[0].chart.totals).toEqual([]);
  });

  it("keeps a pane's published plot when an unrelated pane changes log", () => {
    const { setPaneLogs, setPaneChart } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2661]);
    setPaneChart(0, { totals: [1, 2, 3], format: "amount" });
    useAnalysisPanesStore.getState().setPaneLogs([2657, 2664]);
    expect(useAnalysisPanesStore.getState().panes[0].chart.totals).toEqual([1, 2, 3]);
  });

  it("ignores a write aimed at a pane that no longer exists", () => {
    const { setPaneLogs, setPaneBase } = useAnalysisPanesStore.getState();
    setPaneLogs([2657]);
    setPaneBase(3, 2657, { chartLen: 1 } as never);
    expect(useAnalysisPanesStore.getState().panes).toHaveLength(1);
  });

  // Pane indexes are POSITIONAL and get reused: closing a comparison whose
  // fetch is in flight and opening another puts a live pane back at that index.
  // The `useEncounterData` instance whose generation ref would have vetoed the
  // late response unmounted with the pane, so the slice has to do it.
  it("ignores a landed fetch for a log the pane is no longer showing", () => {
    const { setPaneLogs, setPaneBase } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2661]);
    setPaneBase(1, 2664, { chartLen: 1 } as never);
    expect(useAnalysisPanesStore.getState().panes[1].base).toBeNull();
  });

  it("drops the slices of panes that were closed", () => {
    const { setPaneLogs } = useAnalysisPanesStore.getState();
    setPaneLogs([2657, 2661, 2664]);
    useAnalysisPanesStore.getState().setPaneLogs([2657]);
    expect(useAnalysisPanesStore.getState().panes).toHaveLength(1);
  });

  it("has no cap on how many panes it holds", () => {
    useAnalysisPanesStore.getState().setPaneLogs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(useAnalysisPanesStore.getState().panes).toHaveLength(10);
  });
});
