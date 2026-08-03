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
      <MetricTable
        rows={ROWS}
        columnKeys={["ui.logs.total-damage", "ui.meter-columns.dps"]}
        onPin={() => {}}
        {...props}
      />
    </MantineProvider>
  );

describe("MetricTable", () => {
  it("says why a table is empty in the caller's words", () => {
    // A log that never recorded the metric has nothing to do with the pins, and
    // the default message would send the user clearing them for nothing.
    renderTable({ rows: [], emptyKey: "ui.logs.buffs-empty" });
    expect(screen.getByText("ui.logs.buffs-empty")).toBeTruthy();
  });

  it("grows no row control when no toggle is given", () => {
    const { container } = renderTable();
    expect(container.querySelectorAll(".analysis-row-toggle")).toHaveLength(0);
  });

  it("toggles a row without pinning it", () => {
    // The toggle sits inside the row button, so a click that reached the row
    // would band the row AND descend a level.
    const onToggle = vi.fn();
    const onPin = vi.fn();
    const { container } = renderTable({
      onPin,
      rowToggle: (row) => (row.key === "a" ? { shown: false, onToggle } : null),
    });

    const toggles = container.querySelectorAll(".analysis-row-toggle");
    expect(toggles).toHaveLength(1);

    fireEvent.click(toggles[0]);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPin).not.toHaveBeenCalled();
  });

  it("says why a table is empty in the caller's words", () => {
    // A log that never recorded the metric has nothing to do with the pins, and
    // the default message would send the user clearing them for nothing.
    renderTable({ rows: [], emptyKey: "ui.logs.buffs-empty" });
    expect(screen.getByText("ui.logs.buffs-empty")).toBeTruthy();
  });

  it("grows no row control when no toggle is given", () => {
    const { container } = renderTable();
    expect(container.querySelectorAll(".analysis-row-toggle")).toHaveLength(0);
  });

  it("toggles a row without pinning it", () => {
    // The toggle sits inside the row button, so a click that reached the row
    // would band the row AND descend a level.
    const onToggle = vi.fn();
    const onPin = vi.fn();
    const { container } = renderTable({
      onPin,
      rowToggle: (row) => (row.key === "a" ? { shown: false, onToggle } : null),
    });

    const toggles = container.querySelectorAll(".analysis-row-toggle");
    expect(toggles).toHaveLength(1);

    fireEvent.click(toggles[0]);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPin).not.toHaveBeenCalled();
  });

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
        {
          headingKey: "ui.logs.hover-by-target",
          color: "rgb(1,2,3)",
          entries: [{ key: "t", label: "Boss", value: 5 }],
        },
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

  it("does not nest one interactive control inside another", () => {
    // The row was a <button role="row"> with a focusable role="button" span
    // inside it for the band toggle. A button may not contain interactive
    // content: browsers and screen readers disagree about what a click on the
    // inner control even means, and the row swallowed its own toggle's focus.
    const { container } = renderTable({
      rowToggle: () => ({ shown: false, onToggle: () => {} }),
    });

    expect(container.querySelector("button button")).toBeNull();
    expect(container.querySelector(String.raw`button [role="button"]`)).toBeNull();
    expect(container.querySelector(String.raw`[role="button"] button`)).toBeNull();
  });

  it("makes the band toggle a real button", () => {
    // Not a span wearing role="button": it needs its own focus, its own Enter
    // and Space handling, and its own place in the tab order, all of which the
    // element gives for free and the span had to reimplement.
    const { container } = renderTable({
      rowToggle: () => ({ shown: true, onToggle: () => {} }),
    });

    const toggle = container.querySelector(".analysis-row-toggle");
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not nest one interactive control inside another", () => {
    // The row was a <button role="row"> with a focusable role="button" span
    // inside it for the band toggle. A button may not contain interactive
    // content: browsers and screen readers disagree about what a click on the
    // inner control even means, and the row swallowed its own toggle's focus.
    const { container } = renderTable({
      rowToggle: () => ({ shown: false, onToggle: () => {} }),
    });

    expect(container.querySelector("button button")).toBeNull();
    expect(container.querySelector(String.raw`button [role="button"]`)).toBeNull();
    expect(container.querySelector(String.raw`[role="button"] button`)).toBeNull();
  });

  it("makes the band toggle a real button", () => {
    // Not a span wearing role="button": it needs its own focus, its own Enter
    // and Space handling, and its own place in the tab order, all of which the
    // element gives for free and the span had to reimplement.
    const { container } = renderTable({
      rowToggle: () => ({ shown: true, onToggle: () => {} }),
    });

    const toggle = container.querySelector(".analysis-row-toggle");
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("timeline rows", () => {
  const row = (over: Partial<MetricRow> = {}): MetricRow => ({
    key: "status:10:500",
    label: "status:10:500",
    value: 3_000,
    columns: ["50%", "2"],
    pinOnClick: null,
    colorSlot: -1,
    ...over,
  });

  it("draws one piece per window, positioned across the measured window", () => {
    const { container } = renderTable({
      rows: [
        row({
          timeline: [
            { startMs: 0, endMs: 2_000 },
            { startMs: 8_000, endMs: 10_000 },
          ],
        }),
      ],
      columnKeys: ["ui.logs.buff-uptime", "ui.logs.buff-count"],
      timelineMs: 10_000,
    });

    const pieces = container.querySelectorAll<HTMLElement>(".analysis-timeline-piece");
    expect(pieces).toHaveLength(2);
    expect(pieces[0].style.left).toBe("0%");
    expect(pieces[0].style.width).toBe("20%");
    expect(pieces[1].style.left).toBe("80%");
    expect(pieces[1].style.width).toBe("20%");
  });

  it("draws the magnitude bar, not a timeline, when the row has none", () => {
    const { container } = renderTable({
      rows: [row()],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    expect(container.querySelectorAll(".analysis-timeline-piece")).toHaveLength(0);
    expect(container.querySelectorAll("[data-metric-bar]")).toHaveLength(1);
  });

  it("gives a zero-width window a visible minimum rather than nothing", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 5_000, endMs: 5_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    const piece = container.querySelector<HTMLElement>(".analysis-timeline-piece");
    expect(piece?.style.minWidth).toBe("2px");
  });

  it("falls back to the magnitude bar when the window has no length", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 0, endMs: 1_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 0,
    });

    expect(container.querySelectorAll(".analysis-timeline-piece")).toHaveLength(0);
    expect(container.querySelectorAll("[data-metric-bar]")).toHaveLength(1);
  });

  it("draws the pieces inside a dedicated track cell, not across the row", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 0, endMs: 2_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    const track = container.querySelector(".analysis-track") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track.querySelectorAll(".analysis-timeline-piece")).toHaveLength(1);
    // The name cell is bounded so the track never sits under the text.
    expect(container.querySelector(".analysis-name")?.className).toContain("analysis-name-fixed");
  });

  it("keeps the magnitude rows' name cell fluid", () => {
    const { container } = renderTable({
      rows: [row()],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    expect(container.querySelector(".analysis-name")?.className).not.toContain("analysis-name-fixed");
    expect(container.querySelector(".analysis-track")).toBeNull();
  });
});
