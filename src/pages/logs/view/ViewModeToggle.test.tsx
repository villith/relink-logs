import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `t` returns the key, so assertions read against keys rather than English.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { ViewModeToggle } from "./ViewModeToggle";

const renderIt = () =>
  render(
    <MantineProvider>
      <ViewModeToggle />
    </MantineProvider>
  );

const toggle = () => screen.getByRole("button", { name: "ui.logs.view-mode.toggle" });

describe("ViewModeToggle", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ logs_view_mode: "analysis" });
  });

  it("switches from analysis to classic", () => {
    renderIt();
    fireEvent.click(toggle());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("classic");
  });

  it("switches back from classic to analysis", () => {
    useMeterSettingsStore.setState({ logs_view_mode: "classic" });
    renderIt();
    fireEvent.click(toggle());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });

  /** Two clicks must land where they started — a plain toggle, not a control
   * that can drift into a third state. */
  it("returns to the starting mode after two clicks", () => {
    renderIt();
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });

  /** Invisible to the eye but still a real, named button: it must keep its
   * accessible name so keyboard and screen-reader users can reach it. */
  it("is reachable by its accessible name and writes nothing on render", () => {
    renderIt();

    expect(toggle()).toBeTruthy();
    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });
});
