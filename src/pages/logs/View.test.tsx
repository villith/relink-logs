import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
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
    useMeterSettingsStore.setState({ logs_view: "analysis" });
  });

  it("renders the analysis view by default", () => {
    renderIt();
    expect(screen.getByText("analysis-body")).toBeTruthy();
    expect(screen.queryByText("classic-body")).toBeNull();
  });

  it("renders the classic view when the setting says so", () => {
    useMeterSettingsStore.setState({ logs_view: "classic" });
    renderIt();
    expect(screen.getByText("classic-body")).toBeTruthy();
    expect(screen.queryByText("analysis-body")).toBeNull();
  });

  /** `ViewModeToggle` is the only writer. Rendering reads `logs_view` and
   * must never normalise or rewrite it, or a stored choice would be lost simply
   * by opening a quest. */
  it("does not overwrite the stored setting just by rendering", () => {
    useMeterSettingsStore.setState({ logs_view: "analysis" });
    renderIt();

    expect(useMeterSettingsStore.getState().logs_view).toBe("analysis");
  });

  /** The shell must not reserve a row for the switch any more — the toggle
   * rides inside each body, beside that body's own top-right control. */
  it("renders nothing but the chosen body", () => {
    renderIt();

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
