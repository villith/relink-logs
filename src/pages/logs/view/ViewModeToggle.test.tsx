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

/** The way OUT of Analysis: a labelled button anyone can see. */
const exit = () => screen.getByRole("button", { name: "ui.logs.view-mode.to-classic" });

/** The way IN to Analysis: the unlabelled control that paints nothing. */
const entry = () => screen.getByRole("button", { name: "ui.logs.view-mode.toggle" });

describe("ViewModeToggle", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ logs_view_mode: "analysis" });
  });

  it("switches from analysis to classic", () => {
    renderIt();
    fireEvent.click(exit());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("classic");
  });

  it("switches back from classic to analysis", () => {
    useMeterSettingsStore.setState({ logs_view_mode: "classic" });
    renderIt();
    fireEvent.click(entry());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });

  /** Two clicks must land where they started — a plain toggle, not a control
   * that can drift into a third state. The control it renders differs per mode,
   * so the second click has to find whichever one Analysis' exit left behind. */
  it("returns to the starting mode after two clicks", () => {
    renderIt();
    fireEvent.click(exit());
    fireEvent.click(entry());

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });

  /** Analysis is unfinished and is NOT the default, so the only people on it
   * are people who switched deliberately — but the escape hatch still has to be
   * findable by eye, not just by knowing where to click. Carrying visible text
   * is what separates it from the entry control. */
  it("shows a visible, labelled way out of analysis", () => {
    renderIt();

    expect(exit().textContent).toBe("ui.logs.view-mode.to-classic");
    expect(exit().className).not.toContain("view-mode-toggle");
  });

  /** The way in stays hidden. Classic is what every user opens, and an Analysis
   * button sitting on it would advertise an unfinished view. */
  it("keeps the way in to analysis invisible and unlabelled", () => {
    useMeterSettingsStore.setState({ logs_view_mode: "classic" });
    renderIt();

    expect(entry().textContent).toBe("");
    expect(entry().className).toContain("view-mode-toggle");
    expect(screen.queryByRole("button", { name: "ui.logs.view-mode.to-classic" })).toBeNull();
  });

  it("writes nothing on render", () => {
    renderIt();

    expect(useMeterSettingsStore.getState().logs_view_mode).toBe("analysis");
  });
});
