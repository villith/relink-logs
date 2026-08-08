import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { AnalysisTopBar } from "./AnalysisTopBar";

/** Reports where the bar's Back button landed. Rendered as a sibling so it
 * survives the navigation — the bar itself would too, but reading the location
 * from outside keeps the assertion about routing rather than about the bar. */
const Where = () => {
  const { pathname } = useLocation();
  return <span data-testid="where">{pathname}</span>;
};

const renderIt = (state?: unknown) =>
  render(
    <MantineProvider>
      <MemoryRouter initialEntries={[{ pathname: "/logs/42", state }]}>
        <AnalysisTopBar />
        <Where />
      </MemoryRouter>
    </MantineProvider>
  );

const landedOn = () => screen.getByTestId("where").textContent;

describe("AnalysisTopBar", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ logs_view: "analysis" });
  });

  /** Classic has carried a Back button since it was the only view; Analysis
   * replaces the whole body, so without one of its own a reader who switched
   * has no way off the log but the browser's own control. */
  it("offers a way back off the log", () => {
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "ui.back-btn" }));

    expect(landedOn()).toBe("/logs");
  });

  /** The same "up, not back" rule Classic follows — the destination is the one
   * the link that opened the log declared. See `useBackTo`. */
  it("goes where the link that opened the log said to", () => {
    renderIt({ backTo: "/logs/conflux" });
    fireEvent.click(screen.getByRole("button", { name: "ui.back-btn" }));

    expect(landedOn()).toBe("/logs/conflux");
  });

  /** Stated outright, not parked behind a tooltip on an icon: the view IS a
   * beta, and a caveat that only appears on hover is one most readers never
   * meet. It rides this row because this is the row that offers the way out of
   * the beta — the warning and the switch that answers it read together. */
  it("says the view is unfinished, in the open", () => {
    renderIt();

    expect(screen.getByText("ui.logs.view-mode.beta-warning")).toBeTruthy();
  });

  it("carries the view switch", () => {
    const { container } = renderIt();

    expect(container.querySelector('input[value="classic"]')).toBeTruthy();
    expect(container.querySelector('input[value="analysis"]')).toBeTruthy();
  });

  it("navigates nowhere on render", () => {
    renderIt();

    expect(landedOn()).toBe("/logs/42");
  });
});
