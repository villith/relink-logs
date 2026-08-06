import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EventRowsTable, KIND_COLORS } from "./EventsTab";
import { EVENT_KINDS, type EventRow } from "./eventRows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const ROWS: EventRow[] = [
  {
    timeMs: 1500,
    kind: "damage",
    sourceIndex: 0,
    targetIndex: 9,
    abilityKey: "Normal:100",
    detailKey: null,
    amount: 18204,
  },
  {
    timeMs: 41880,
    kind: "death",
    sourceIndex: 1,
    targetIndex: null,
    abilityKey: null,
    detailKey: "ui.logs.events-died",
    amount: null,
  },
];

const LABELS = {
  source: (index: number) => `player-${index}`,
  target: (index: number) => `enemy-${index}`,
  ability: (key: string) => `skill(${key})`,
};

const renderTable = (rows = ROWS, startIndex = 0) =>
  render(
    <MantineProvider>
      <EventRowsTable rows={rows} rowHeight={22} startIndex={startIndex} totalRows={rows.length} labels={LABELS} />
    </MantineProvider>
  );

describe("EventRowsTable", () => {
  it("renders every column header", () => {
    renderTable();
    expect(screen.getByText("ui.logs.events-time")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-source")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-ability")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-target")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-amount")).toBeTruthy();
  });

  it("formats the timestamp to the millisecond", () => {
    renderTable();
    expect(screen.getByText("00:01.500")).toBeTruthy();
  });

  it("resolves indexes to display names rather than printing raw ids", () => {
    renderTable();
    expect(screen.getByText("player-0")).toBeTruthy();
    expect(screen.getByText("enemy-9")).toBeTruthy();
    expect(screen.getByText("skill(Normal:100)")).toBeTruthy();
  });

  it("shows a detail line where a row has no ability", () => {
    renderTable([ROWS[1]]);
    expect(screen.getByText("ui.logs.events-died")).toBeTruthy();
  });

  it("leaves absent fields blank rather than zero", () => {
    // A death has no target and no amount; rendering "0" would read as data.
    const { container } = renderTable([ROWS[1]]);
    expect(container.querySelector("[data-amount-cell]")?.textContent).toBe("");
    expect(container.querySelector("[data-target-cell]")?.textContent).toBe("");
  });

  it("gives every kind its own colour", () => {
    for (const kind of EVENT_KINDS) expect(KIND_COLORS[kind]).toBeDefined();
    expect(new Set(Object.values(KIND_COLORS)).size).toBe(EVENT_KINDS.length);
  });

  it("positions rows by absolute index so scrolling stays aligned", () => {
    const { container } = renderTable(ROWS, 100);
    const first = container.querySelector<HTMLElement>("[data-event-row]");
    expect(first?.style.top).toBe("2200px");
  });

  it("sizes the spacer by the WHOLE filtered list, not the rendered slice", () => {
    // The scrollbar's length comes from this. Sized by the slice, scrolling would
    // stop a few rows in and the rest of the fight would be unreachable.
    const { container } = render(
      <MantineProvider>
        <EventRowsTable rows={ROWS} rowHeight={22} startIndex={100} totalRows={1000} labels={LABELS} />
      </MantineProvider>
    );
    expect(container.querySelector<HTMLElement>("[data-event-body]")?.style.height).toBe("22000px");
  });
});
