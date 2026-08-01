import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MetricTable } from "./MetricTable";
import type { MetricRow } from "./metrics/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const ROWS: MetricRow[] = [
  { key: "a", label: "Narmaya", value: 300, columns: ["300", "30"], pinOnClick: { source: 0 } },
  { key: "b", label: "Eugen", value: 100, columns: ["100", "10"], pinOnClick: { source: 1 } },
];

const renderTable = (props: Partial<React.ComponentProps<typeof MetricTable>> = {}) =>
  render(
    <MantineProvider>
      <MetricTable rows={ROWS} columnKeys={["ui.logs.total-damage"]} onPin={() => {}} {...props} />
    </MantineProvider>
  );

describe("MetricTable", () => {
  it("renders one row per metric row", () => {
    renderTable();
    expect(screen.getByText("Narmaya")).toBeTruthy();
    expect(screen.getByText("Eugen")).toBeTruthy();
  });

  it("scales bars against the largest row, not the total", () => {
    // The biggest row is always full width; everything else is relative to it.
    const { container } = renderTable();
    const bars = container.querySelectorAll<HTMLElement>("[data-metric-bar]");
    expect(bars[0].style.width).toBe("100%");
    // Compared as a number: the exact float tail is not the behaviour under test.
    expect(parseFloat(bars[1].style.width)).toBeCloseTo(100 / 3, 6);
  });

  it("pins on row click", () => {
    const onPin = vi.fn();
    renderTable({ onPin });
    screen.getByText("Narmaya").click();
    expect(onPin).toHaveBeenCalledWith({ source: 0 });
  });

  it("does not pin a leaf row", () => {
    const onPin = vi.fn();
    const leaf: MetricRow[] = [{ key: "c", label: "Hit", value: 5, columns: ["5"], pinOnClick: null }];
    renderTable({ rows: leaf, onPin });
    screen.getByText("Hit").click();
    expect(onPin).not.toHaveBeenCalled();
  });

  it("renders an empty state rather than an empty table", () => {
    renderTable({ rows: [] });
    expect(screen.getByText("ui.logs.no-rows")).toBeTruthy();
  });

  it("draws every row when they are all zero", () => {
    // A fight with no stun at all: rows must still be listed, at zero width,
    // rather than vanishing behind a NaN.
    const zeros: MetricRow[] = [
      { key: "a", label: "Narmaya", value: 0, columns: ["0"], pinOnClick: null },
      { key: "b", label: "Eugen", value: 0, columns: ["0"], pinOnClick: null },
    ];
    const { container } = renderTable({ rows: zeros });
    const bars = container.querySelectorAll<HTMLElement>("[data-metric-bar]");
    expect(bars).toHaveLength(2);
    expect(bars[0].style.width).toBe("0%");
  });

  it("uses the caller's label renderer when one is given", () => {
    // The display-name lookup needs i18n and settings, so it is injected
    // rather than reached for from inside the table.
    renderTable({ renderLabel: (row: MetricRow) => `<${row.key}>` });
    expect(screen.getByText("<a>")).toBeTruthy();
  });
});
