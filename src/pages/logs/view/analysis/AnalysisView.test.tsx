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
vi.mock("./AnalysisPane", () => ({
  AnalysisPane: ({ paneIndex, logId }: { paneIndex: number; logId: number }) => (
    <div data-testid="pane" data-pane-index={paneIndex} data-log-id={logId} />
  ),
}));
vi.mock("./AnalysisTopBar", () => ({ AnalysisTopBar: () => <div data-testid="top-bar" /> }));

import { AnalysisView } from "./AnalysisView";

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

  // The suffixed keys are POSITIONAL: closing the middle pane has to move the
  // pane above it down onto the vacated keys, and clear what it left behind.
  // nuqs keeps a param nothing reads, so an uncleared `src2` would lie dormant
  // and revive on whatever log later occupied pane 2.
  it("shifts the panes above a closed one down, and clears the vacated keys", async () => {
    renderView("/logs/2657?compare=2661,2664&src1=1&src2=7&aura2=src:status:4:1:unknown");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(search().get("compare")).toBe("2664"));
    expect(search().get("src1")).toBe("7");
    expect(search().has("src2")).toBe(false);
    expect(search().has("aura2")).toBe(false);
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
