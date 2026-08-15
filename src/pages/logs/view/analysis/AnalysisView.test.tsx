import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The pane is the whole view — charts, fetches, Tauri IPC. The frame's job is
// to decide WHICH panes exist and what they are given, so stub the pane and
// assert the decision.
vi.mock("./AnalysisPane", () => ({
  AnalysisPane: ({ paneIndex, logId }: { paneIndex: number; logId: number }) => (
    <div data-testid="pane" data-pane-index={paneIndex} data-log-id={logId} />
  ),
}));
vi.mock("./AnalysisTopBar", () => ({ AnalysisTopBar: () => <div data-testid="top-bar" /> }));

import { AnalysisView } from "./AnalysisView";

const renderView = (path = "/logs/2657") =>
  render(
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

describe("AnalysisView", () => {
  it("opens the log in the path as pane 0", () => {
    renderView();

    const panes = screen.getAllByTestId("pane");
    expect(panes).toHaveLength(1);
    expect(panes[0].dataset.paneIndex).toBe("0");
    expect(panes[0].dataset.logId).toBe("2657");
  });

  it("keeps the top bar outside the panes, so a second log does not bring a second one", () => {
    renderView();
    expect(screen.getAllByTestId("top-bar")).toHaveLength(1);
  });
});
