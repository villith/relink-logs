import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  /**
   * THE SHIPPING GATE. The Analysis view is unfinished, so a release build must
   * not offer it at all.
   *
   * Hiding the switch is not enough on its own: `logs_view_mode` defaults to
   * "analysis" and is PERSISTED, so anyone who has already opened a quest on a
   * dev build carries that setting into the release and would be stranded on
   * the half-built view with no control left to escape it. The release ignores
   * the setting outright rather than defaulting it.
   *
   * Vitest runs with `DEV` true, so every other test in this file is the
   * dev-mode behaviour and this block is the only one that has to say so.
   */
  describe("in a release build", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", false);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("shows the classic view even when the stored setting says analysis", () => {
      useMeterSettingsStore.setState({ logs_view_mode: "analysis" });
      renderIt();

      expect(screen.getByText("classic-body")).toBeTruthy();
      expect(screen.queryByText("analysis-body")).toBeNull();
    });

    it("offers no way to switch views", () => {
      renderIt();
      expect(screen.queryByRole("radio")).toBeNull();
    });

    /** The setting is left ALONE rather than rewritten to "classic": a dev who
     * flips back to a dev build should find their own choice still there. */
    it("does not overwrite the stored setting", () => {
      renderIt();
      expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
    });
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
