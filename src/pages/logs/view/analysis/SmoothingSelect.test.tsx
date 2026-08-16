import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SmoothingSelect } from "./SmoothingSelect";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${Object.values(params).join(" ")}`,
  }),
}));

const renderIt = (props: Partial<React.ComponentProps<typeof SmoothingSelect>> = {}) =>
  render(
    <MantineProvider>
      <SmoothingSelect value={10} onChange={() => {}} {...props} />
    </MantineProvider>
  );

const trigger = () => screen.getByRole("button", { name: "ui.logs.chart-smoothing-label" });
const open = () => fireEvent.click(trigger());

describe("SmoothingSelect", () => {
  // One slot in the control row instead of four pills, and the closed state has
  // to say which window is running or the reader cannot tell a smoothed plot
  // from a raw one.
  it("states the current window on the trigger", () => {
    renderIt({ value: 30 });

    expect(trigger().textContent).toContain("ui.logs.chart-smoothing-seconds 30");
  });

  it("reads a one-bucket window as off, since a one-bucket mean is the bucket", () => {
    renderIt({ value: 1 });

    expect(trigger().textContent).toContain("ui.logs.chart-smoothing-off");
  });

  it("offers every window, off included", () => {
    renderIt();
    open();

    // By option rather than by text: the trigger states the current window, so
    // that one label is on screen twice.
    expect([...document.querySelectorAll("[data-smoothing-option]")].map((row) => row.textContent)).toEqual([
      "ui.logs.chart-smoothing-off",
      "ui.logs.chart-smoothing-seconds 5",
      "ui.logs.chart-smoothing-seconds 10",
      "ui.logs.chart-smoothing-seconds 30",
    ]);
  });

  // "Off 5s 10s 30s" names four durations and no question, so something must
  // say what is being chosen — inside the menu, where the choice is being made,
  // rather than as a permanent word in the strip.
  it("captions the menu rather than the control row", () => {
    renderIt();
    expect(screen.queryByText("ui.logs.chart-smoothing-caption")).toBeNull();

    open();
    expect(screen.getByText("ui.logs.chart-smoothing-caption")).toBeTruthy();
  });

  it("reports the chosen window in buckets", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    open();

    fireEvent.click(screen.getByText("ui.logs.chart-smoothing-seconds 5"));

    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("ticks the window in force", () => {
    renderIt({ value: 5 });
    open();

    const ticked = document.querySelector('[data-smoothing-option="5"]');
    const other = document.querySelector('[data-smoothing-option="30"]');
    expect(ticked!.querySelector(".bg-accent")).toBeTruthy();
    expect(other!.querySelector(".bg-accent")).toBeNull();
  });
});
