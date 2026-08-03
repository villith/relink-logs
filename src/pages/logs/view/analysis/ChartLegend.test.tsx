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
