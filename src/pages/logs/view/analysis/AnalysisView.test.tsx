import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
  }),
}));

// The pane is the whole view — charts, fetches, Tauri IPC. The frame's job is
// to decide WHICH panes exist, what they are given, and what the controls they
// share write, so stub the pane and assert the decisions.
//
// A FRAGMENT of sections, like the real pane: it draws a header, a selector bar,
// a chart and a body as siblings, and a stub that returned one element would
// hide whether the frame gives a pane a column or lets its sections loose in the
// grid (see "one column per pane" below).
vi.mock("./AnalysisPane", () => ({
  AnalysisPane: ({
    paneIndex,
    logId,
    drawsChart,
    paneEnds,
  }: {
    paneIndex: number;
    logId: number;
    drawsChart: boolean;
    paneEnds: { bucket: number; label: string }[];
  }) => (
    <>
      <div
        data-testid="pane"
        data-pane-index={paneIndex}
        data-log-id={logId}
        data-draws-chart={String(drawsChart)}
        data-pane-ends={paneEnds.map((end) => `${end.label}@${end.bucket}`).join(",")}
      />
      <div data-testid="pane-section" />
    </>
  ),
}));
vi.mock("./AnalysisTopBar", () => ({ AnalysisTopBar: () => <div data-testid="top-bar" /> }));
vi.mock("./CompareChart", () => ({
  CompareChart: ({ perPaneTotals }: { perPaneTotals: number[][] }) => (
    <div data-testid="compare-chart" data-panes={perPaneTotals.length} />
  ),
}));

import { useAnalysisPanesStore, type PaneChart, type PaneSources } from "@/stores/useAnalysisPanesStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { AnalysisView } from "./AnalysisView";

const EMPTY_CHART: PaneChart = { totals: [], format: "amount" };
const NO_SRC: PaneSources = { options: [], value: null, onChange: () => {} };

// The react-router v6 adapter reads the initial search params from the REAL
// `location.search`, not from MemoryRouter's in-memory history — so a pre-seeded
// URL has to land on `window.location` too, or nuqs never sees it.
const renderView = (path = "/logs/2657") => {
  window.history.replaceState(null, "", path);
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[path]}>
        <NuqsAdapter>
          <Routes>
            <Route path="/logs/:id" element={<AnalysisView />} />
          </Routes>
        </NuqsAdapter>
      </MemoryRouter>
    </MantineProvider>
  );
};

const paneLogIds = () => screen.getAllByTestId("pane").map((pane) => pane.dataset.logId);
const removeButtons = () => screen.queryAllByLabelText("ui.logs.compare-remove");
const search = () => new URLSearchParams(window.location.search);

describe("AnalysisView", () => {
  it("opens the log in the path as pane 0", () => {
    renderView();

    const panes = screen.getAllByTestId("pane");
    expect(panes).toHaveLength(1);
    expect(panes[0].dataset.paneIndex).toBe("0");
    expect(panes[0].dataset.logId).toBe("2657");
  });

  it("keeps the top bar outside the panes, so a second log does not bring a second one", () => {
    renderView("/logs/2657?compare=2661");
    expect(screen.getAllByTestId("top-bar")).toHaveLength(1);
  });

  it("opens a pane per compared log, the path log first", () => {
    renderView("/logs/2657?compare=2661,2664");

    expect(paneLogIds()).toEqual(["2657", "2661", "2664"]);
  });

  // A pane draws a STACK of sections, and the frame lays the panes out as grid
  // columns. The frame therefore has to give each pane a cell of its own: loose
  // sections auto-flow into the grid one item each, which fills the columns
  // row by row and interleaves the two logs down the page — pane 0's header
  // beside pane 0's actor bar, pane 0's table beside pane 1's header.
  it("gives each pane one column, however many sections it draws", () => {
    const { container } = renderView("/logs/2657?compare=2661");

    const grid = container.querySelector(".analysis-panes");
    expect(grid?.children).toHaveLength(2);
    // Each cell holds ONE pane and all of its sections, rather than one section.
    for (const cell of Array.from(grid?.children ?? [])) {
      expect(cell.querySelectorAll("[data-testid='pane']")).toHaveLength(1);
      expect(cell.querySelectorAll("[data-testid='pane-section']")).toHaveLength(1);
    }
  });

  it("ignores a compare entry that cannot name a log", () => {
    renderView("/logs/2657?compare=banana");

    expect(paneLogIds()).toEqual(["2657"]);
  });

  it("compares the open log against itself when + Compare is pressed", async () => {
    renderView();

    fireEvent.click(screen.getByText("ui.logs.compare-add"));

    await waitFor(() => expect(search().get("compare")).toBe("2657"));
    expect(paneLogIds()).toEqual(["2657", "2657"]);
  });

  it("drops the compare param entirely when the last comparison closes", async () => {
    renderView("/logs/2657?compare=2661");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().has("compare")).toBe(false));
    expect(paneLogIds()).toEqual(["2657"]);
  });

  // One control closes one pane — the LAST — so it can sit where + Compare
  // does rather than needing a ✕ per column (see `ActorBar`).
  it("closes the last pane, whatever the compare param holds", async () => {
    renderView("/logs/2657?compare=2661,2664");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().get("compare")).toBe("2661"));
    expect(paneLogIds()).toEqual(["2657", "2661"]);
  });

  // The suffixed keys are POSITIONAL, so a closed pane's must be cleared: nuqs
  // keeps a param nothing reads, and an uncleared `src2` would lie dormant and
  // revive on whatever log later occupied pane 2. (Which key moves where is
  // `paneRemovalWrites`'s own concern, and tested there.)
  it("clears the keys the closed pane leaves behind", async () => {
    renderView("/logs/2657?compare=2661,2664&src1=1&src2=7&aura2=src:status:4:1:unknown");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().get("compare")).toBe("2661"));
    expect(search().get("src1")).toBe("1");
    expect(search().has("src2")).toBe(false);
    expect(search().has("aura2")).toBe(false);
  });

  // Only while comparing: with one log open there is nothing to close, and the
  // control that row carries is + Compare instead.
  it("offers no close control with a single log open", () => {
    renderView();
    expect(removeButtons()).toHaveLength(0);
    expect(screen.getByText("ui.logs.compare-add")).toBeTruthy();
  });

  it("offers exactly one close control while comparing, and no + Compare", () => {
    renderView("/logs/2657?compare=2661");
    expect(removeButtons()).toHaveLength(1);
    expect(screen.queryByText("ui.logs.compare-add")).toBeNull();
  });

  it("leaves pane 0's own pins alone when a comparison closes", async () => {
    renderView("/logs/2657?compare=2661&src=4");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().has("compare")).toBe(false));
    expect(search().get("src")).toBe("4");
  });

  // A shared control writes for EVERY pane: a metric change drops each pane's
  // grouping override, and a pane left on the old one would group by a
  // dimension the new metric may not have.
  it("applies a metric change to every pane", async () => {
    renderView("/logs/2657?compare=2661&by=source&by1=target");

    fireEvent.click(screen.getByText("ui.logs.metric-stun"));

    await waitFor(() => expect(search().get("metric")).toBe("stun"));
    expect(search().has("by")).toBe(false);
    expect(search().has("by1")).toBe(false);
  });

  it("keeps the metric unsuffixed, however many panes are open", async () => {
    renderView("/logs/2657?compare=2661");

    fireEvent.click(screen.getByText("ui.logs.metric-stun"));

    await waitFor(() => expect(search().get("metric")).toBe("stun"));
    expect(search().has("metric1")).toBe(false);
  });

  it("leaves the single-log view its own full chart, and offers no compare layout", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    renderView();

    expect(screen.getAllByTestId("pane")[0].dataset.drawsChart).toBe("true");
    expect(screen.queryByTestId("compare-chart")).toBeNull();
    expect(screen.queryByText("ui.logs.compare-chart-overlay")).toBeNull();
  });

  // One plot for the comparison, and the panes stand down: the same data drawn
  // once above and once per pane is two answers to one question.
  it("overlays the comparison on one plot, and the panes then draw none", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    renderView("/logs/2657?compare=2661");

    expect(screen.getByTestId("compare-chart").dataset.panes).toBe("2");
    expect(screen.getAllByTestId("pane").map((pane) => pane.dataset.drawsChart)).toEqual(["false", "false"]);
  });

  it("leaves every pane its own chart when the comparison is split", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "split" });
    renderView("/logs/2657?compare=2661");

    expect(screen.queryByTestId("compare-chart")).toBeNull();
    expect(screen.getAllByTestId("pane").map((pane) => pane.dataset.drawsChart)).toEqual(["true", "true"]);
  });

  // Split, the two plots share no axis, so a shorter run just stops and reads as
  // a fight that went quiet. Each pane is told where EVERY log ended so it can
  // rule a line there. Its own entry rides along and `visibleEndLines` drops it
  // — its bucket is that chart's own last one — so which rules exist has one
  // author rather than a filter here and a rule there.
  it("tells each pane where every log ended", () => {
    useAnalysisPanesStore.setState({
      panes: [
        { logId: 2657, base: null, chart: { totals: [1, 2, 3, 4], format: "amount" }, sources: NO_SRC },
        { logId: 2661, base: null, chart: { totals: [1, 2], format: "amount" }, sources: NO_SRC },
      ],
    });
    renderView("/logs/2657?compare=2661");

    // Both panes hear both ends, in pane order: #2657 at bucket 3, #2661 at 1.
    // Pane 0 draws only #2661's, pane 1 only #2657's — `visibleEndLines` is
    // what makes that call, and it has its own test.
    expect(screen.getAllByTestId("pane").map((pane) => pane.dataset.paneEnds)).toEqual([
      "#2657@3,#2661@1",
      "#2657@3,#2661@1",
    ]);
  });

  // One log open: its own end is the only entry, and its own chart drops it —
  // so nothing is ruled, which is what a single pane has always shown.
  it("gives a single pane only its own end, which its chart drops", () => {
    useAnalysisPanesStore.setState({
      panes: [{ logId: 2657, base: null, chart: { totals: [1, 2, 3, 4], format: "amount" }, sources: NO_SRC }],
    });
    renderView();
    expect(screen.getAllByTestId("pane")[0].dataset.paneEnds).toBe("#2657@3");
  });

  // The source pin is a SHARED row now: one selector per log, drawn by the
  // frame from what the panes publish, so a comparison picks one source from
  // each fight.
  it("draws one source selector per pane, from what the panes published", () => {
    useAnalysisPanesStore.setState({
      panes: [
        { logId: 2657, base: null, chart: EMPTY_CHART, sources: NO_SRC },
        { logId: 2661, base: null, chart: EMPTY_CHART, sources: NO_SRC },
      ],
    });
    renderView("/logs/2657?compare=2661");

    expect(screen.getAllByPlaceholderText("ui.logs.selector-all-friendlies")).toHaveLength(2);
  });

  // The side toggle clears both actor pins, in every pane — they name the
  // universe the view just left.
  it("clears every pane's actor pins on a side swap", async () => {
    renderView("/logs/2657?compare=2661&src=1&src1=3");

    fireEvent.click(screen.getByText("ui.logs.hostility-enemies"));

    await waitFor(() => expect(search().get("side")).toBe("enemy"));
    expect(search().has("src")).toBe(false);
    expect(search().has("src1")).toBe(false);
  });
});
