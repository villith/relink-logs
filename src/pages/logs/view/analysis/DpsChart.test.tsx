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

  it("drops the card entirely when nothing landed in the bucket", () => {
    // Every series at zero — a box holding only a timestamp says nothing.
    renderTooltip([
      { dataKey: "0", name: "0", value: 0, color: "#f00" },
      { dataKey: "1", name: "1", value: 0, color: "#0f0" },
    ]);

    expect(screen.queryByText("03:03")).toBeNull();
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
