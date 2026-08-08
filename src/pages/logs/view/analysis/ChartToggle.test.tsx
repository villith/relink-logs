import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChartToggle } from "./ChartToggle";

const renderIt = (props: Partial<React.ComponentProps<typeof ChartToggle>> = {}) =>
  render(
    <MantineProvider>
      <ChartToggle label="SBA windows" color="#da77f2" shown onToggle={() => {}} {...props} />
    </MantineProvider>
  );

describe("ChartToggle", () => {
  it("names itself and reports its pressed state", () => {
    renderIt();
    const button = screen.getByRole("button", { name: "SBA windows" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("dims rather than removes when switched off", () => {
    // Removing it would leave no way to bring the series back.
    const { container } = renderIt({ shown: false });
    expect(screen.getByRole("button", { name: "SBA windows" }).getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-legend-swatch]")).toBeTruthy();
    expect(screen.getByText("SBA windows")).toBeTruthy();
  });

  it("wears the series' own colour, so identity never rides colour alone", () => {
    const { container } = renderIt();
    const swatch = container.querySelector("[data-legend-swatch]") as HTMLElement;
    expect(swatch.style.backgroundColor).toBe("rgb(218, 119, 242)");
  });

  it("draws a band as a square and a marker as a line", () => {
    // The row sits directly above a plot where the two visibly differ.
    const band = renderIt({ glyph: "band" });
    expect(band.container.querySelector("[data-legend-swatch]")?.className).toContain("size-");

    const marker = renderIt({ glyph: "marker" });
    const glyph = marker.container.querySelector("[data-legend-swatch]")?.className ?? "";
    expect(glyph).toContain("w-[calc(3px*var(--density))]");
  });

  it("toggles on click", () => {
    const onToggle = vi.fn();
    renderIt({ onToggle });
    fireEvent.click(screen.getByRole("button", { name: "SBA windows" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
