import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChartLegend } from "./ChartLegend";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const ENTRIES = [
  { key: "0", label: "Rain", color: "#f00" },
  { key: "1", label: "Manmoth", color: "#0f0" },
];

const renderLegend = (hidden: Set<string> = new Set(), onToggle = () => {}) =>
  render(
    <MantineProvider>
      <ChartLegend entries={ENTRIES} hidden={hidden} onToggle={onToggle} />
    </MantineProvider>
  );

describe("ChartLegend", () => {
  it("renders one entry per series", () => {
    renderLegend();
    expect(screen.getByText("Rain")).toBeTruthy();
    expect(screen.getByText("Manmoth")).toBeTruthy();
  });

  it("toggles the clicked series by key", () => {
    const onToggle = vi.fn();
    renderLegend(new Set(), onToggle);

    fireEvent.click(screen.getByText("Manmoth"));

    expect(onToggle).toHaveBeenCalledWith("1");
  });

  it("marks a hidden entry pressed-off rather than removing it", () => {
    // Removing it would leave no way to bring the series back.
    renderLegend(new Set(["1"]));
    const entries = screen.getAllByRole("button");

    expect(entries[0].getAttribute("aria-pressed")).toBe("true");
    expect(entries[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("dims a hidden entry", () => {
    const { container } = renderLegend(new Set(["1"]));
    const swatches = container.querySelectorAll<HTMLElement>("[data-legend-swatch]");

    expect(swatches[0].style.opacity).toBe("1");
    expect(swatches[1].style.opacity).not.toBe("1");
  });

  it("renders nothing for no series", () => {
    const { container } = render(
      <MantineProvider>
        <ChartLegend entries={[]} hidden={new Set()} onToggle={() => {}} />
      </MantineProvider>
    );

    expect(container.querySelectorAll("[data-legend-swatch]")).toHaveLength(0);
  });
});

describe("ChartLegend — the capped tail", () => {
  // Three plotted bands and four ranked past the cap. A busy fight puts 40+
  // abilities here, which is why the tail folds away rather than wrapping the
  // legend down the page.
  const WITH_TAIL = [
    ...ENTRIES,
    { key: "other", label: "Other", color: "#999" },
    { key: "t1", label: "Rising Sword", color: "#00f", tail: true },
    { key: "t2", label: "Wild Magica", color: "#0ff", tail: true },
    { key: "t3", label: "Sword Shower", color: "#f0f", tail: true },
  ];

  const renderTail = (hidden: Set<string> = new Set(["t1", "t2", "t3"]), onToggle = () => {}) =>
    render(
      <MantineProvider>
        <ChartLegend entries={WITH_TAIL} hidden={hidden} onToggle={onToggle} />
      </MantineProvider>
    );

  it("keeps the tail folded away at rest, behind a control that counts it", () => {
    renderTail();
    expect(screen.getByText("Rain")).toBeTruthy();
    expect(screen.queryByText("Rising Sword")).toBeNull();
    expect(screen.getByText("ui.logs.chart-legend-show-more")).toBeTruthy();
  });

  it("reveals every tail entry when the control is used", () => {
    renderTail();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));

    expect(screen.getByText("Rising Sword")).toBeTruthy();
    expect(screen.getByText("Sword Shower")).toBeTruthy();
    // And offers the way back.
    expect(screen.getByText("ui.logs.chart-legend-show-fewer")).toBeTruthy();
  });

  it("greys the revealed tail entries, since they are not plotted yet", () => {
    // "Greyed out but activatable" is the whole point: they read as available
    // rather than as bands the plot is already drawing.
    const { container } = renderTail();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));

    const swatch = (label: string) =>
      container.querySelector<HTMLElement>(`[data-legend-key="${label}"] [data-legend-swatch]`)!;
    expect(swatch("t1").style.opacity).not.toBe("1");
    expect(swatch("0").style.opacity).toBe("1");
  });

  it("activates a tail entry by key, the same click any other entry takes", () => {
    const onToggle = vi.fn();
    renderTail(new Set(["t1", "t2", "t3"]), onToggle);
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));

    fireEvent.click(screen.getByText("Wild Magica"));
    expect(onToggle).toHaveBeenCalledWith("t2");
  });

  it("keeps a tail entry the user switched on visible with the tail folded", () => {
    // Folding the list back must not hide a band that IS being plotted — the
    // legend would then be drawing a colour it does not explain.
    renderTail(new Set(["t2", "t3"]));
    expect(screen.getByText("Rising Sword")).toBeTruthy();
    expect(screen.queryByText("Wild Magica")).toBeNull();
  });

  it("offers no control at all when nothing is ranked past the cap", () => {
    renderLegend();
    expect(screen.queryByText("ui.logs.chart-legend-show-more")).toBeNull();
  });
});
