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
    linkedWrite,
  }: {
    paneIndex: number;
    logId: number;
    drawsChart: boolean;
    paneEnds: { bucket: number; label: string }[];
    linkedWrite?: unknown;
  }) => (
    <>
      <div
        data-testid="pane"
        data-pane-index={paneIndex}
        data-log-id={logId}
        data-draws-chart={String(drawsChart)}
        data-linked={String(linkedWrite !== undefined)}
        data-pane-ends={paneEnds.map((end) => `${end.label}@${end.bucket}`).join(",")}
      />
      <div data-testid="pane-section" />
    </>
  ),
}));
vi.mock("./AnalysisTopBar", () => ({ AnalysisTopBar: () => <div data-testid="top-bar" /> }));
vi.mock("./CompareChart", () => ({
  CompareChart: ({
    perPaneTotals,
    windowBands,
    windowTooltips,
    markers,
  }: {
    perPaneTotals: number[][];
    windowBands?: { kind: string }[];
    windowTooltips?: { tag?: { text: string; color: string } }[];
    markers?: { atMs: number; tag?: { text: string; color: string } }[];
  }) => (
    <div
      data-testid="compare-chart"
      data-panes={perPaneTotals.length}
      data-window-bands={(windowBands ?? []).map((band) => band.kind).join(",")}
      data-window-tags={(windowTooltips ?? []).map((entry) => entry.tag?.text ?? "").join(",")}
      data-window-tag-colors={(windowTooltips ?? []).map((entry) => entry.tag?.color ?? "").join(",")}
      data-marker-times={(markers ?? []).map((marker) => marker.atMs).join(",")}
      data-marker-tags={(markers ?? []).map((marker) => marker.tag?.text ?? "").join(",")}
      data-marker-tag-colors={(markers ?? []).map((marker) => marker.tag?.color ?? "").join(",")}
    />
  ),
}));

import { useAnalysisPanesStore, type PaneChart, type PaneSources } from "@/stores/useAnalysisPanesStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { COMPARE_COLORS } from "@/utils";

import { AnalysisView } from "./AnalysisView";
import { SBA_MARKER_COLOR, type ChartMarker } from "./chartMarkers";
import { WINDOW_BAND_COLOR, type WindowKind } from "./chartWindowBands";
import { EMPTY_PANE_WINDOWS, type PaneWindows } from "./compareWindows";

const EMPTY_CHART: PaneChart = { totals: [], format: "amount" };
const NO_SRC: PaneSources = { options: [], value: null, onChange: () => {} };
const NO_WINDOWS: PaneWindows = EMPTY_PANE_WINDOWS;
const NO_MARKERS: ChartMarker[] = [];

const paneMarkers = (atMs: number[]): ChartMarker[] =>
  atMs.map((at) => ({ kind: "sba", atMs: at, color: SBA_MARKER_COLOR, label: `Skybound Art @${at}` }));

const paneWindows = (kinds: WindowKind[]): PaneWindows => ({
  bands: kinds.map((kind) => ({ kind, color: WINDOW_BAND_COLOR[kind], band: { startMs: 0, endMs: 1_000, stacks: 1 } })),
  tooltips: kinds.map((kind) => ({
    kind,
    startMs: 0,
    endMs: 1_000,
    color: WINDOW_BAND_COLOR[kind],
    text: `${kind} 0:00–0:01`,
  })),
});

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
const removeButtons = () => screen.queryAllByText("ui.logs.compare-remove");
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

  // One control, closing pane 1 — the comparison the + Compare beside it opened.
  // A third pane is only reachable by hand-editing the URL (the add control is
  // replaced by this one the moment a second log is open), and closing pane 1
  // then shifts the rest down rather than closing the end of the list.
  it("closes pane 1, whatever the compare param holds", async () => {
    renderView("/logs/2657?compare=2661,2664");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().get("compare")).toBe("2664"));
    expect(paneLogIds()).toEqual(["2657", "2664"]);
  });

  // The suffixed keys are POSITIONAL, so the survivors shift down and the vacated
  // index must be cleared: nuqs keeps a param nothing reads, and an uncleared
  // `src2` would lie dormant and revive on whatever log later occupied pane 2.
  // (Which key moves where is `paneRemovalWrites`'s own concern, tested there.)
  it("shifts the surviving pane's keys down and clears the vacated ones", async () => {
    renderView("/logs/2657?compare=2661,2664&src1=1&src2=7&aura2=src:status:4:1:unknown");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().get("compare")).toBe("2664"));
    expect(search().get("src1")).toBe("7");
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

  it("puts the chart-layout switch immediately before the body tabs", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    renderView("/logs/2657?compare=2661");

    const layout = screen.getByRole("radiogroup", { name: "ui.logs.compare-chart-label" });
    const tabs = screen.getByRole("tablist", { name: "ui.logs.view-tablist-label" });
    expect(layout.parentElement).toBe(tabs.parentElement);
    const row = Array.from(tabs.parentElement?.children ?? []);
    expect(row.indexOf(layout)).toBeLessThan(row.indexOf(tabs));
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
        {
          logId: 2657,
          base: null,
          chart: { totals: [1, 2, 3, 4], format: "amount" },
          sources: NO_SRC,
          windows: NO_WINDOWS,
          markers: NO_MARKERS,
        },
        {
          logId: 2661,
          base: null,
          chart: { totals: [1, 2], format: "amount" },
          sources: NO_SRC,
          windows: NO_WINDOWS,
          markers: NO_MARKERS,
        },
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
      panes: [
        {
          logId: 2657,
          base: null,
          chart: { totals: [1, 2, 3, 4], format: "amount" },
          sources: NO_SRC,
          windows: NO_WINDOWS,
          markers: NO_MARKERS,
        },
      ],
    });
    renderView();
    expect(screen.getAllByTestId("pane")[0].dataset.paneEnds).toBe("#2657@3");
  });

  // The source pin belongs to the pane, under the picker naming its log — the
  // frame draws none at all.
  it("draws no source selector of its own", () => {
    useAnalysisPanesStore.setState({
      panes: [
        { logId: 2657, base: null, chart: EMPTY_CHART, sources: NO_SRC, windows: NO_WINDOWS, markers: NO_MARKERS },
      ],
    });
    renderView();

    expect(screen.queryAllByPlaceholderText("ui.logs.selector-all-friendlies")).toHaveLength(0);
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

  // One chart means one question, so a target, an ability or an aura picked in
  // any pane has to select the same thing in the others. WHICH dimensions
  // travel is `LINKED_DIMS`'s call and has its own test; the frame only decides
  // whether they travel at all.
  it("links the panes' pins while the comparison draws one chart", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    renderView("/logs/2657?compare=2661");

    expect(screen.getAllByTestId("pane").map((pane) => pane.dataset.linked)).toEqual(["true", "true"]);
  });

  it("leaves a split comparison's panes their own pins", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "split" });
    renderView("/logs/2657?compare=2661");

    expect(screen.getAllByTestId("pane").map((pane) => pane.dataset.linked)).toEqual(["false", "false"]);
  });

  it("links nothing with a single log open", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    renderView();

    expect(screen.getAllByTestId("pane")[0].dataset.linked).toBe("false");
  });

  // The overlay has no fight of its own, so the battle-state shading has to come
  // from the panes — all of them, so a Break one run had and the other did not
  // is visible rather than only reachable by switching to Split.
  it("shades every pane's battle windows on the one chart", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    useAnalysisPanesStore.setState({
      panes: [
        {
          logId: 2657,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: paneWindows(["break"]),
          markers: NO_MARKERS,
        },
        {
          logId: 2661,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: paneWindows(["sba", "break"]),
          markers: NO_MARKERS,
        },
      ],
    });
    renderView("/logs/2657?compare=2661");

    // Kind order, not pane order — the same order a single log's own chart
    // shades in.
    expect(screen.getByTestId("compare-chart").dataset.windowBands).toBe("sba,break,break");
  });

  // The row's swatch is the KIND's colour — the card groups these under one
  // heading per kind — so the id is the only thing left that can say which run
  // a span belongs to, and it wears that run's own line colour.
  it("tags every window line with its log, in that log's line colour", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    useAnalysisPanesStore.setState({
      panes: [
        {
          logId: 2657,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: paneWindows(["break"]),
          markers: NO_MARKERS,
        },
        {
          logId: 2661,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: paneWindows(["break"]),
          markers: NO_MARKERS,
        },
      ],
    });
    renderView("/logs/2657?compare=2661");

    const chart = screen.getByTestId("compare-chart");
    expect(chart.dataset.windowTags).toBe("#2657,#2661");
    expect(chart.dataset.windowTagColors).toBe(`${COMPARE_COLORS[0]},${COMPARE_COLORS[1]}`);
  });

  // The SBA shading merges a chain of casts into one span, so the markers are
  // the only thing on the overlay saying how many Skybound Arts a run got off —
  // and each one is tagged with its log for the same reason a window line is.
  it("draws every pane's SBA casts on the one chart, tagged by log", () => {
    useMeterSettingsStore.setState({ compare_chart_mode: "overlay" });
    useAnalysisPanesStore.setState({
      panes: [
        {
          logId: 2657,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: NO_WINDOWS,
          markers: paneMarkers([1_000, 9_000]),
        },
        {
          logId: 2661,
          base: null,
          chart: EMPTY_CHART,
          sources: NO_SRC,
          windows: NO_WINDOWS,
          markers: paneMarkers([4_000]),
        },
      ],
    });
    renderView("/logs/2657?compare=2661");

    const chart = screen.getByTestId("compare-chart");
    // Time order across the panes, not pane order.
    expect(chart.dataset.markerTimes).toBe("1000,4000,9000");
    expect(chart.dataset.markerTags).toBe("#2657,#2661,#2657");
    expect(chart.dataset.markerTagColors).toBe(`${COMPARE_COLORS[0]},${COMPARE_COLORS[1]},${COMPARE_COLORS[0]}`);
  });
});
