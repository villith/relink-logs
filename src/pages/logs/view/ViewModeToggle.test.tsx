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

/** The options are radios inside Mantine's SegmentedControl. Found by VALUE
 * rather than by accessible name: the Beta option's name also carries its WIP
 * badge, so a name match would be asserting the badge's copy by accident. */
const option = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

describe("ViewModeToggle", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ logs_view: "analysis" });
  });

  /** Both directions are ordinary, visible options now. The way in used to
   * paint nothing at all, which hid the redesigned view from everyone who did
   * not already know where to click. */
  it("offers both views as visible, labelled options", () => {
    const { container } = renderIt();

    expect(screen.getByText("ui.logs.view-mode.classic")).toBeTruthy();
    expect(screen.getByText("ui.logs.view-mode.beta")).toBeTruthy();
    expect(option(container, "classic")).toBeTruthy();
    expect(option(container, "analysis")).toBeTruthy();
  });

  /** The Beta option carries its own warning. The view is unfinished, and a
   * plain second tab beside Classic would present the two as equals. */
  it("marks the beta option as work-in-progress", () => {
    renderIt();

    expect(screen.getByText("ui.logs.view-mode.wip")).toBeTruthy();
  });

  it("shows which view is current", () => {
    const { container } = renderIt();

    expect(option(container, "analysis").checked).toBe(true);
    expect(option(container, "classic").checked).toBe(false);
  });

  it("switches from analysis to classic", () => {
    const { container } = renderIt();
    fireEvent.click(option(container, "classic"));

    expect(useMeterSettingsStore.getState().logs_view).toBe("classic");
  });

  it("switches back from classic to analysis", () => {
    useMeterSettingsStore.setState({ logs_view: "classic" });
    const { container } = renderIt();
    fireEvent.click(option(container, "analysis"));

    expect(useMeterSettingsStore.getState().logs_view).toBe("analysis");
  });

  /** Two clicks must land where they started — a plain toggle, not a control
   * that can drift into a third state. */
  it("returns to the starting mode after two clicks", () => {
    const { container } = renderIt();
    fireEvent.click(option(container, "classic"));
    fireEvent.click(option(container, "analysis"));

    expect(useMeterSettingsStore.getState().logs_view).toBe("analysis");
  });

  it("writes nothing on render", () => {
    renderIt();

    expect(useMeterSettingsStore.getState().logs_view).toBe("analysis");
  });
});
