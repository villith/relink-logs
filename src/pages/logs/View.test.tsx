import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `t` returns the key, so assertions read against keys rather than English.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Both bodies are heavy (charts, fetches, Tauri IPC). The shell's job is only
// to pick one, so stub them and assert the pick.
vi.mock("./view/ClassicView", () => ({ ClassicView: () => <div>classic-body</div> }));
vi.mock("./view/analysis/AnalysisView", () => ({ AnalysisView: () => <div>analysis-body</div> }));

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { ViewPage } from "./View";

const renderIt = () =>
  render(
    <MantineProvider>
      <ViewPage />
    </MantineProvider>
  );

describe("ViewPage", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ logs_view_mode: "analysis" });
  });

  it("renders the analysis view by default", () => {
    renderIt();
    expect(screen.getByText("analysis-body")).toBeTruthy();
    expect(screen.queryByText("classic-body")).toBeNull();
  });

  it("renders the classic view when the setting says so", () => {
    useMeterSettingsStore.setState({ logs_view_mode: "classic" });
    renderIt();
    expect(screen.getByText("classic-body")).toBeTruthy();
    expect(screen.queryByText("analysis-body")).toBeNull();
  });

  it("writes the choice back to the settings store", () => {
    renderIt();

    // Mantine's SegmentedControl is a radio group; the visible label is the
    // radio's accessible name.
    fireEvent.click(screen.getByRole("radio", { name: "ui.logs.view-mode.classic" }));

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("classic");
  });
});
