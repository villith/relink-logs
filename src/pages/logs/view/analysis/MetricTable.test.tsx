import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../metrics/types";

import { MetricTable } from "./MetricTable";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const ROWS: MetricRow[] = [
  { key: "a", label: "Narmaya", value: 300, columns: ["300", "30"], pinOnClick: { source: 0 }, colorSlot: 0 },
  { key: "b", label: "Eugen", value: 100, columns: ["100", "10"], pinOnClick: { source: 1 }, colorSlot: 1 },
];

const renderTable = (props: Partial<React.ComponentProps<typeof MetricTable>> = {}) =>
  render(
    <MantineProvider>
      <MetricTable rows={ROWS} columnKeys={["ui.logs.total-damage", "ui.meter-columns.dps"]} onPin={() => {}} {...props} />
    </MantineProvider>
  );

describe("MetricTable", () => {
  it("renders one row per metric row", () => {
    renderTable();
    expect(screen.getByText("Narmaya")).toBeTruthy();
    expect(screen.getByText("Eugen")).toBeTruthy();
  });

  it("scales bars against the largest row, not the total", () => {
    const { container } = renderTable();
    const bars = container.querySelectorAll<HTMLElement>("[data-metric-bar]");
    expect(bars[0].style.width).toBe("100%");
    expect(parseFloat(bars[1].style.width)).toBeCloseTo(100 / 3, 6);
  });

  it("draws no rank number", () => {
    // Rows are already ordered and the bar shows the magnitude; a rank column
    // repeats what the order says and steals width from the name.
    const { container } = renderTable();
    expect(container.querySelectorAll(".analysis-rank")).toHaveLength(0);
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("colours a bar from its row's slot, not its position", () => {
    // A filter that drops the top row must not repaint the survivor: colour
    // follows the entity.
    const { container } = renderTable({
      rows: [ROWS[1]],
      rowColor: (row: MetricRow) => (row.colorSlot === 1 ? "rgb(1, 2, 3)" : "rgb(9, 9, 9)"),
    });
    const bar = container.querySelector<HTMLElement>("[data-metric-bar]");
    expect(bar?.style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("pins on row click", () => {
    const onPin = vi.fn();
    renderTable({ onPin });
    screen.getByText("Narmaya").click();
    expect(onPin).toHaveBeenCalledWith({ source: 0 });
  });

  it("does not pin a leaf row", () => {
    const onPin = vi.fn();
    const leaf: MetricRow[] = [
      { key: "c", label: "Hit", value: 5, columns: ["5", ""], pinOnClick: null, colorSlot: -1 },
    ];
    renderTable({ rows: leaf, onPin });
    screen.getByText("Hit").click();
    expect(onPin).not.toHaveBeenCalled();
  });

  it("renders an empty state rather than an empty table", () => {
    renderTable({ rows: [] });
    expect(screen.getByText("ui.logs.no-rows")).toBeTruthy();
  });

  it("draws every row when they are all zero", () => {
    const zeros: MetricRow[] = [
      { key: "a", label: "Narmaya", value: 0, columns: ["0", "0"], pinOnClick: null, colorSlot: 0 },
      { key: "b", label: "Eugen", value: 0, columns: ["0", "0"], pinOnClick: null, colorSlot: 1 },
    ];
    const { container } = renderTable({ rows: zeros });
    const bars = container.querySelectorAll<HTMLElement>("[data-metric-bar]");
    expect(bars).toHaveLength(2);
    expect(bars[0].style.width).toBe("0%");
  });

  it("uses the caller's label renderer when one is given", () => {
    renderTable({ renderLabel: (row: MetricRow) => `<${row.key}>` });
    expect(screen.getByText("<a>")).toBeTruthy();
  });

  it("names what the rows are", () => {
    renderTable({ rowsLabelKey: "ui.logs.rows-by-player" });
    expect(screen.getByText("ui.logs.rows-by-player")).toBeTruthy();
  });

  it("wraps a row in a hover card when the caller supplies sections", () => {
    const { container } = renderTable({
      rowSections: () => [
        { headingKey: "ui.logs.hover-by-target", color: "rgb(1,2,3)", entries: [{ key: "t", label: "Boss", value: 5 }] },
      ],
    });
    const row = container.querySelector<HTMLElement>(".analysis-row");
    expect(row).toBeTruthy();
    fireEvent.mouseOver(row!);
    expect(screen.getByTestId("metric-hover-card")).toBeTruthy();
    expect(screen.getByText("Boss")).toBeTruthy();
  });

  it("renders rows unwrapped when no sections are supplied", () => {
    renderTable();
    expect(screen.queryByTestId("metric-hover-card")).toBeNull();
  });
});
