import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Label } from "../DetailCharts";

import { ChartTooltip } from "./DpsChart";

const LABELS: Label = [
  { name: "0", label: "Rain", partySlotIndex: 0, color: "#f00" },
  { name: "1", label: "Manmoth", partySlotIndex: 1, color: "#0f0" },
];

const renderTooltip = (payload: Record<string, unknown>[], labels: Label = LABELS) =>
  render(
    <MantineProvider>
      <ChartTooltip label="03:03" payload={payload} format="amount" labels={labels} />
    </MantineProvider>
  );

describe("ChartTooltip", () => {
  it("names a series by its label, not by its key", () => {
    // The key is an actor index, so an unresolved tooltip reads "4026531840".
    renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }]);
    expect(screen.getByText("Rain")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("falls back to the key when no label matches", () => {
    // A stale series key must still show something, not blank out the row.
    renderTooltip([{ dataKey: "9", name: "9", value: 5, color: "#00f" }]);
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("keeps two same-labelled players as two rows", () => {
    // Rows are keyed by dataKey, never by label: an online party can hold two
    // "AI" players and React would drop the duplicate.
    const both: Label = [
      { name: "0", label: "AI", partySlotIndex: 0, color: "#f00" },
      { name: "1", label: "AI", partySlotIndex: 1, color: "#0f0" },
    ];
    renderTooltip(
      [
        { dataKey: "0", name: "0", value: 10, color: "#f00" },
        { dataKey: "1", name: "1", value: 20, color: "#0f0" },
      ],
      both
    );
    expect(screen.getAllByText("AI")).toHaveLength(2);
  });

  it("leaves out a series that contributed nothing to the bucket", () => {
    // A stack of 17 bands is mostly zeroes at any one moment, and a tooltip
    // listing every one of them buries the few that actually landed.
    renderTooltip([
      { dataKey: "0", name: "0", value: 1000, color: "#f00" },
      { dataKey: "1", name: "1", value: 0, color: "#0f0" },
    ]);

    expect(screen.getByText("Rain")).toBeTruthy();
    expect(screen.queryByText("Manmoth")).toBeNull();
  });

  it("hides the card when nothing landed, without collapsing it to nothing", () => {
    // Every series at zero. The card must not be UNMOUNTED: recharts positions
    // its wrapper by transform only while the measured box is non-zero
    // (getTooltipTranslate), and then force-sets visibility:visible over its own
    // hidden style — so a zero-size box parks the card at the plot's top-left
    // corner, and it stays there until the next mouse move because updateBBox
    // mutates a field rather than state. Measured: 4 of 31 samples across the
    // plot painted at left:29px, the plot's own left edge.
    const { container } = renderTooltip([
      { dataKey: "0", name: "0", value: 0, color: "#f00" },
      { dataKey: "1", name: "1", value: 0, color: "#0f0" },
    ]);

    const card = container.querySelector<HTMLElement>('[data-testid="chart-tooltip"]');
    expect(card).toBeTruthy();
    expect(card!.style.visibility).toBe("hidden");
    // Hidden, not empty: `visibility` keeps the box in layout, which is the
    // whole point — an empty box is what parks the wrapper.
    expect(screen.getByText("03:03")).toBeTruthy();
  });

  it("orders entries by value, largest first", () => {
    // The payload arrives in series order, which is the stack's order over the
    // WHOLE fight — at any one second the biggest contributor is rarely first.
    renderTooltip([
      { dataKey: "0", name: "0", value: 100, color: "#f00" },
      { dataKey: "1", name: "1", value: 900, color: "#0f0" },
    ]);

    const names = [...document.querySelectorAll("span")].map((s) => s.textContent);
    expect(names.indexOf("Manmoth")).toBeLessThan(names.indexOf("Rain"));
  });

  it("keeps a gauge reading of zero out too", () => {
    // The SBA tab is a percentage: 0% is as uninformative as 0 damage.
    renderTooltip([{ dataKey: "0", name: "0", value: 0, color: "#f00" }], LABELS);
    expect(screen.queryByText("Rain")).toBeNull();
  });

  it("labels a drill band by its group name", () => {
    const bands: Label = [
      { name: 'Group:reginleiv@"Pl2000"', label: "Reginleiv Recidiv", partySlotIndex: 0, color: "#f00" },
    ];
    renderTooltip(
      [{ dataKey: 'Group:reginleiv@"Pl2000"', name: 'Group:reginleiv@"Pl2000"', value: 1, color: "#f00" }],
      bands
    );
    expect(screen.getByText("Reginleiv Recidiv")).toBeTruthy();
  });
});

