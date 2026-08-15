import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LogSummary } from "@/types";

import { CompareHeader } from "./CompareHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
  }),
}));

const log = (id: number): LogSummary => ({
  id,
  time: 1_700_000_000,
  duration: 1,
  questId: 2657,
  questElapsedTime: 180,
  p1Type: "Pl1400",
  p2Type: null,
  p3Type: null,
  p4Type: null,
  repeatGroup: null,
});

const renderHeader = (over: Partial<React.ComponentProps<typeof CompareHeader>> = {}) =>
  render(
    <MantineProvider>
      <CompareHeader
        logs={[log(1), log(2)]}
        paneLogIds={[1]}
        onAddPane={vi.fn()}
        onRemovePane={vi.fn()}
        onChangePaneLog={vi.fn()}
        {...over}
      />
    </MantineProvider>
  );

const removeButtons = () => screen.queryAllByLabelText("ui.logs.compare-remove");

describe("CompareHeader", () => {
  it("offers a picker per pane", () => {
    renderHeader({ paneLogIds: [1, 2] });
    expect(screen.getAllByLabelText("ui.logs.picker-label")).toHaveLength(2);
  });

  it("offers + Compare while only one log is open", () => {
    renderHeader();
    expect(screen.getByText("ui.logs.compare-add")).toBeTruthy();
  });

  // Pane 0 is the log in the path — closing it means leaving the page, not
  // closing a comparison.
  it("shows one remove control per comparison, and none for the path log", () => {
    renderHeader({ paneLogIds: [1, 2] });
    expect(removeButtons()).toHaveLength(1);
  });

  it("shows no remove control at all while nothing is compared", () => {
    renderHeader();
    expect(removeButtons()).toHaveLength(0);
  });

  it("removes the pane it was clicked on", () => {
    const onRemovePane = vi.fn();
    renderHeader({ paneLogIds: [1, 2], onRemovePane });

    fireEvent.click(removeButtons()[0]);

    expect(onRemovePane).toHaveBeenCalledWith(1);
  });

  it("reports which pane changed log", () => {
    const onChangePaneLog = vi.fn();
    renderHeader({ paneLogIds: [1, 2], onChangePaneLog });

    fireEvent.click(screen.getAllByLabelText("ui.logs.picker-label")[1]);
    const option = screen.getAllByRole("option").find((node) => node.textContent?.includes("#1"));
    fireEvent.click(option as HTMLElement);

    expect(onChangePaneLog).toHaveBeenCalledWith(1, 1);
  });
});
