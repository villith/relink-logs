import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChartDatapoint, Label } from "../DetailCharts";

import type { ChartMarker } from "./chartMarkers";
import { TOTAL_SERIES_KEY } from "./chartSeries";
import type { WindowKind } from "./chartWindowBands";
import { ChartTooltip, DpsChart, visibleEndLines } from "./DpsChart";
import { SECTION_ENTRY_CAP } from "./HoverCard";

const LABELS: Label = [
  { name: "0", label: "Rain", partySlotIndex: 0, color: "#f00" },
  { name: "1", label: "Manmoth", partySlotIndex: 1, color: "#0f0" },
];

const renderTooltip = (payload: Record<string, unknown>[], labels: Label = LABELS, markers?: ChartMarker[]) =>
  render(
    <MantineProvider>
      <ChartTooltip
        label="03:03"
        payload={payload}
        format="amount"
        labels={labels}
        sectionKey="ui.logs.rows-by-player"
        markers={markers}
      />
    </MantineProvider>
  );

/** The tooltip of a STACKED plot, which reports a total it sums itself. */
const renderStacked = (payload: Record<string, unknown>[], labels: Label = LABELS) =>
  render(
    <MantineProvider>
      <ChartTooltip
        label="03:03"
        payload={payload}
        format="amount"
        labels={labels}
        sectionKey="ui.logs.rows-by-ability"
        sumTotal
      />
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

  it("renders tooltip entries as card sections with bars", () => {
    // The chart's tooltip and the table's hover card are ONE body, so a reading
    // taken off the chart looks like the same reading taken off the table.
    renderTooltip([
      { dataKey: "0", name: "0", value: 100, color: "#f00" },
      { dataKey: "1", name: "1", value: 40, color: "#0f0" },
    ]);

    expect(screen.getByText("Rain")).toBeTruthy();
    // Bars arrive with the card body — the whole point of sharing it.
    expect(screen.getAllByTestId("metric-bar-segment").length).toBeGreaterThan(0);
  });

  it("orders entries by value, largest first", () => {
    // The payload arrives in series order, which is the stack's order over the
    // WHOLE fight — at any one second the biggest contributor is rarely first.
    const { container } = renderTooltip([
      { dataKey: "0", name: "0", value: 100, color: "#f00" },
      { dataKey: "1", name: "1", value: 900, color: "#0f0" },
    ]);

    const names = [...container.querySelectorAll("[data-card-name]")].map((cell) => cell.textContent);
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

  it("appends the bucket's marker lines after the series rows", () => {
    renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }], LABELS, [
      { kind: "death", atMs: 183_000, color: "#f00", label: "☠ Rain died" },
    ]);
    expect(screen.getByText("☠ Rain died")).toBeTruthy();

    // Existence alone doesn't pin the ordering constraint this task exists to
    // enforce — check DOM position too, the same way "orders entries by
    // value" above does. The series rows live inside the shared card body and
    // the markers in a card section of their own, so the comparison is between
    // the tooltip's SECTIONS rather than between sibling paragraphs (and not
    // between its direct children, which the animated-height wrapper owns).
    const blocks = [...document.querySelectorAll('[data-testid="chart-tooltip"] [data-card-section]')].map(
      (block) => block.textContent
    );
    const seriesRowIndex = blocks.findIndex((text) => text?.includes("Rain"));
    const markerRowIndex = blocks.findIndex((text) => text?.includes("☠ Rain died"));
    expect(seriesRowIndex).toBeGreaterThanOrEqual(0);
    expect(markerRowIndex).toBeGreaterThan(seriesRowIndex);
  });

  it("renders every marker when more than one lands in the same bucket", () => {
    // chartMarkers.ts documents that ties at the same atMs can co-occur and are
    // unordered — two players SBA-ing together, or two deaths at once.
    renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }], LABELS, [
      { kind: "death", atMs: 183_000, color: "#f00", label: "☠ Rain died" },
      { kind: "sba", atMs: 183_000, color: "#0ff", label: "Manmoth — Skybound Art" },
    ]);
    expect(screen.getByText("☠ Rain died")).toBeTruthy();
    expect(screen.getByText("Manmoth — Skybound Art")).toBeTruthy();
  });

  it("draws the actor's art beside a marker that has any", () => {
    // Load-bearing on the SBA rows: every SBA line wears ONE colour, so the
    // swatch says only that an SBA happened — the art is what says by whom.
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }], LABELS, [
      { kind: "sba", atMs: 183_000, color: "#0ff", label: "Manmoth — Skybound Art", icon: "/char/manmoth.png" },
    ]);
    const art = container.querySelector("[data-card-name] img");
    expect(art?.getAttribute("src")).toBe("/char/manmoth.png");
    expect(art?.getAttribute("alt")).toBe("");
  });

  it("draws no art for a marker whose actor resolves none, rather than a blank box", () => {
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }], LABELS, [
      { kind: "sba", atMs: 183_000, color: "#0ff", label: "Manmoth — Skybound Art" },
    ]);
    expect(container.querySelector("[data-card-name] img")).toBeNull();
    // The row is still there — the swatch and the words carry it.
    expect(screen.getByText("Manmoth — Skybound Art")).toBeTruthy();
  });

  it("stays visible for a bucket where nothing landed but a marker did", () => {
    // The zero-suppression guard hides the card when every series is zero; a
    // marker is exactly the content that must still show there — a death is
    // usually WHY the bucket is all zeroes.
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 0, color: "#f00" }], LABELS, [
      { kind: "sba", atMs: 183_000, color: "#0ff", label: "Manmoth — Skybound Art" },
    ]);
    const card = container.querySelector<HTMLElement>('[data-testid="chart-tooltip"]');
    expect(card!.style.visibility).not.toBe("hidden");
    expect(screen.getByText("Manmoth — Skybound Art")).toBeTruthy();
  });

  it("still hides the card when an explicit empty markers array accompanies all-zero series", () => {
    // The zero-series test above omits `markers` entirely, exercising
    // `undefined?.length ?? 0`; pin the `[].length` branch of the same guard
    // explicitly, since this guard is exactly what this task changed.
    const { container } = renderTooltip(
      [
        { dataKey: "0", name: "0", value: 0, color: "#f00" },
        { dataKey: "1", name: "1", value: 0, color: "#0f0" },
      ],
      LABELS,
      []
    );
    const card = container.querySelector<HTMLElement>('[data-testid="chart-tooltip"]');
    expect(card!.style.visibility).toBe("hidden");
  });
});

describe("ChartTooltip — art and a card that holds still", () => {
  /** Rows of the breakdown section, placeholders included. */
  const breakdownRows = (container: HTMLElement) =>
    container.querySelector("[data-card-section]")!.querySelectorAll("[data-card-row]");

  const WITH_ART: Label = [
    { name: "0", label: "Rain", partySlotIndex: 0, color: "#f00", icon: "rain.png" },
    { name: "1", label: "Manmoth", partySlotIndex: 1, color: "#0f0" },
  ];

  it("draws a series' art beside its name, at the height of its bar", () => {
    // The tooltip's rows ARE the table's rows one level in, and the table has
    // shown this art all along — the breakdown listed bare text beside it.
    // In its own box rather than inside the name cell, for the reason the
    // table's rows draw it that way: at bar height it cannot sit inside a
    // one-line truncating text.
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 1000, color: "#f00" }], WITH_ART);

    const art = container.querySelector<HTMLImageElement>("[data-card-row] img");
    expect(art?.src).toContain("rain.png");
    expect(art?.className).toContain("size-art-card");
  });

  it("draws the placeholder box on a series with no art, like a table row", () => {
    // A combo action, a rollup remainder and a gauge cause depict nothing, but
    // the box still draws — the same faint diamond an artless table row gets —
    // so a mixed section's names hold one left edge instead of zigzagging
    // against the table the card explains.
    const { container } = renderTooltip([{ dataKey: "1", name: "1", value: 1000, color: "#0f0" }], WITH_ART);

    expect(container.querySelector("[data-card-row] img")).toBeNull();
    expect(container.querySelector("[data-row-art-empty]")).toBeTruthy();
    expect(screen.getByText("Manmoth")).toBeTruthy();
  });

  it("gives the card a fixed width", () => {
    // Left to its content it was as wide as the longest label in the bucket
    // under the cursor, so it changed width as the pointer crossed the plot.
    const narrow = renderTooltip([{ dataKey: "0", name: "0", value: 1, color: "#f00" }]);
    const width = narrow.container.querySelector<HTMLElement>("[data-testid='chart-tooltip']")!.style.width;
    narrow.unmount();

    const wide: Label = [{ name: "0", label: "A very much longer series name", partySlotIndex: 0, color: "#f00" }];
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 1, color: "#f00" }], wide);

    expect(width).not.toBe("");
    expect(container.querySelector<HTMLElement>("[data-testid='chart-tooltip']")!.style.width).toBe(width);
  });

  it("holds the breakdown at one row per plotted series as buckets empty out", () => {
    // A stack of bands is mostly zeroes at any one second. Dropping the zero
    // rows is right — they bury the few that fired — but the rows left behind
    // must not shrink the card, or it resizes under the cursor every move.
    const three: Label = [
      { name: "0", label: "Rain", partySlotIndex: 0, color: "#f00" },
      { name: "1", label: "Manmoth", partySlotIndex: 1, color: "#0f0" },
      { name: "2", label: "Zeta", partySlotIndex: 2, color: "#00f" },
    ];
    const busy = renderTooltip(
      [
        { dataKey: "0", name: "0", value: 30, color: "#f00" },
        { dataKey: "1", name: "1", value: 20, color: "#0f0" },
        { dataKey: "2", name: "2", value: 10, color: "#00f" },
      ],
      three
    );
    expect(breakdownRows(busy.container)).toHaveLength(3);
    busy.unmount();

    const quiet = renderTooltip(
      [
        { dataKey: "0", name: "0", value: 30, color: "#f00" },
        { dataKey: "1", name: "1", value: 0, color: "#0f0" },
        { dataKey: "2", name: "2", value: 0, color: "#00f" },
      ],
      three
    );
    expect(breakdownRows(quiet.container)).toHaveLength(3);
    expect(screen.queryByText("Manmoth")).toBeNull();
  });

  it("does not count the Total series as a breakdown slot", () => {
    // The Total is the sum OF the breakdown, and it has its own section —
    // reserving a row for it would leave one blank line in every card.
    const withTotal: Label = [
      { name: TOTAL_SERIES_KEY, label: "Total", partySlotIndex: -1, color: "#888" },
      { name: "0", label: "Rain", partySlotIndex: 0, color: "#f00" },
    ];
    const { container } = renderTooltip(
      [
        { dataKey: TOTAL_SERIES_KEY, name: TOTAL_SERIES_KEY, value: 30, color: "#888" },
        { dataKey: "0", name: "0", value: 30, color: "#f00" },
      ],
      withTotal
    );

    expect(breakdownRows(container)).toHaveLength(1);
  });
});

describe("ChartTooltip — markers and battle windows as card sections", () => {
  const SERIES = [{ dataKey: "0", name: "0", value: 1000, color: "#f00" }];

  const renderWith = (markers?: ChartMarker[], windowLines?: { kind: WindowKind; color: string; text: string }[]) =>
    render(
      <MantineProvider>
        <ChartTooltip
          label="03:03"
          payload={SERIES}
          format="amount"
          labels={LABELS}
          sectionKey="ui.logs.rows-by-player"
          markers={markers}
          windowLines={windowLines}
        />
      </MantineProvider>
    );

  it("heads each battle-window kind with its own name instead of listing bare lines", () => {
    const { container } = renderWith(undefined, [
      { kind: "sba", color: "#0ff", text: "01:02–01:10 · 8s · 1.2M" },
      { kind: "link", color: "#ff0", text: "01:04–01:14 · 10s · 900k" },
    ]);

    expect(screen.getByText("ui.logs.chart-window-sba")).toBeTruthy();
    expect(screen.getByText("ui.logs.chart-window-link")).toBeTruthy();
    // Card sections, the same shell the breakdown above them uses — one for
    // the series, one per window kind.
    expect(container.querySelectorAll("[data-card-section]")).toHaveLength(3);
  });

  it("gathers two windows of one kind under a single heading", () => {
    // Two SBA performances can overlap one bucket; a heading per LINE would
    // repeat the word rather than group them.
    renderWith(undefined, [
      { kind: "sba", color: "#0ff", text: "01:02–01:10 · 8s" },
      { kind: "sba", color: "#0ff", text: "01:05–01:13 · 8s" },
    ]);
    expect(screen.getAllByText("ui.logs.chart-window-sba")).toHaveLength(1);
    expect(screen.getByText("01:02–01:10 · 8s")).toBeTruthy();
    expect(screen.getByText("01:05–01:13 · 8s")).toBeTruthy();
  });

  it("heads the markers by their kind too", () => {
    renderWith([
      { kind: "death", atMs: 183_000, color: "#f00", label: "☠ Rain died" },
      { kind: "sba", atMs: 183_000, color: "#0ff", label: "Manmoth — Skybound Art" },
    ]);
    expect(screen.getByText("ui.logs.chart-marker-deaths")).toBeTruthy();
    expect(screen.getByText("ui.logs.chart-marker-sba")).toBeTruthy();
    expect(screen.getByText("☠ Rain died")).toBeTruthy();
  });

  it("carries each row's colour as a swatch rather than as coloured text", () => {
    // The card's rows identify by a colour block beside a readable name; bare
    // coloured text is the thing that stopped matching the design.
    const { container } = renderWith(undefined, [{ kind: "break", color: "rgb(1, 2, 3)", text: "Vrazarek · 12s" }]);
    const swatch = container.querySelector<HTMLElement>("[data-card-swatch]");
    expect(swatch).toBeTruthy();
    expect(swatch!.style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("keeps the series breakdown above the markers, and the markers above the windows", () => {
    const { container } = renderWith(
      [{ kind: "death", atMs: 1, color: "#f00", label: "☠ Rain died" }],
      [{ kind: "sba", color: "#0ff", text: "01:02–01:10 · 8s" }]
    );
    const text = [...container.querySelectorAll("[data-card-section]")].map((s) => s.textContent ?? "");
    expect(text.findIndex((t) => t.includes("Rain") && !t.includes("died"))).toBe(0);
    expect(text.findIndex((t) => t.includes("☠ Rain died"))).toBe(1);
    expect(text.findIndex((t) => t.includes("01:02–01:10 · 8s"))).toBe(2);
  });
});

describe("ChartTooltip — the Total series", () => {
  // The Total is a SERIES like any other in the payload, so it arrived as one
  // more breakdown row: it sat in the ranking above every player it sums, and
  // its presence in the section total halved everyone's share.
  const WITH_TOTAL: Label = [{ name: TOTAL_SERIES_KEY, label: "Total", partySlotIndex: -1, color: "#888" }, ...LABELS];
  const payload = [
    { dataKey: TOTAL_SERIES_KEY, name: TOTAL_SERIES_KEY, value: 400, color: "#888" },
    { dataKey: "0", name: "0", value: 300, color: "#f00" },
    { dataKey: "1", name: "1", value: 100, color: "#0f0" },
  ];

  it("keeps the Total out of the breakdown section", () => {
    const { container } = renderTooltip(payload, WITH_TOTAL);
    const breakdown = container.querySelectorAll("[data-card-section]")[0];
    const names = [...breakdown.querySelectorAll("[data-card-name]")].map((cell) => cell.textContent);
    expect(names).toEqual(["Rain", "Manmoth"]);
  });

  it("states shares over the players alone, not over the players plus their own sum", () => {
    // 300 of the players' own 400 is 75.0%. Counted against 800 — the two
    // players plus the Total that already contains them — it reads 37.5%, and
    // the section silently claims to sum to 100% while every row is halved.
    renderTooltip(payload, WITH_TOTAL);
    expect(screen.getByText("75.0%")).toBeTruthy();
    expect(screen.getByText("25.0%")).toBeTruthy();
    expect(screen.queryByText("37.5%")).toBeNull();
    expect(screen.queryByText("12.5%")).toBeNull();
  });

  it("gives the Total its own section, below the breakdown and with no share", () => {
    const { container } = renderTooltip(payload, WITH_TOTAL);
    const sections = [...container.querySelectorAll("[data-card-section]")];
    expect(sections).toHaveLength(2);
    expect(sections[1].textContent).toContain("Total");
    // Its share of itself is 100% by construction — a column that can only
    // read 100% says nothing.
    expect(sections[1].querySelector("[data-card-share]")).toBeNull();
  });

  it("draws no Total section on a chart that neither plots nor sums one", () => {
    const { container } = renderTooltip([{ dataKey: "0", name: "0", value: 200, color: "#f00" }]);
    expect(container.querySelectorAll("[data-card-section]")).toHaveLength(1);
  });

  it("sums the bands into a Total on a stacked chart, which plots no Total series", () => {
    // Damage done > done by ability: the stack's HEIGHT is the total, but a
    // Total series inside a Mantine stacked AreaChart would be added to the
    // stack and double it — so the card computes the figure already on screen.
    const { container } = renderStacked([
      { dataKey: "a", name: "a", value: 300, color: "#f00" },
      { dataKey: "b", name: "b", value: 120, color: "#0f0" },
    ]);
    const sections = [...container.querySelectorAll("[data-card-section]")];
    expect(sections).toHaveLength(2);
    expect(sections[1].textContent).toContain("420");
    expect(sections[1].querySelector("[data-card-share]")).toBeNull();
  });

  it("sums over every band, not just the five the section shows", () => {
    // The entry cap is a DISPLAY limit; a total that honoured it would report
    // less damage than the stack it sits under actually draws.
    const bands = Array.from({ length: SECTION_ENTRY_CAP + 3 }, (_, i) => ({
      dataKey: `b${i}`,
      name: `b${i}`,
      value: 10,
      color: "#f00",
    }));
    const { container } = renderStacked(bands);
    const sections = [...container.querySelectorAll("[data-card-section]")];
    expect(sections[1].textContent).toContain(String(10 * (SECTION_ENTRY_CAP + 3)));
  });

  it("prefers a plotted Total series over summing the bands", () => {
    // Where both are available the plotted series is the exact figure — it is
    // summed pre-cap over every fetched series, legend state included.
    const { container } = renderStacked([
      { dataKey: TOTAL_SERIES_KEY, name: TOTAL_SERIES_KEY, value: 999, color: "#888" },
      { dataKey: "0", name: "0", value: 300, color: "#f00" },
    ]);
    const sections = [...container.querySelectorAll("[data-card-section]")];
    expect(sections[1].textContent).toContain("999");
    // 999 + 300 humanizes to "1.3k" — the figure a card that summed anyway
    // would print.
    expect(sections[1].textContent).not.toContain("1.3k");
  });

  it("still hides the card when the Total is the only thing in the bucket", () => {
    // A Total of zero over zeroed players is the all-quiet bucket, and the
    // zero-suppression guard has to keep seeing it as one.
    const { container } = renderTooltip(
      [
        { dataKey: TOTAL_SERIES_KEY, name: TOTAL_SERIES_KEY, value: 0, color: "#888" },
        { dataKey: "0", name: "0", value: 0, color: "#f00" },
      ],
      WITH_TOTAL
    );
    expect(container.querySelector<HTMLElement>('[data-testid="chart-tooltip"]')!.style.visibility).toBe("hidden");
  });
});

describe("ChartTooltip — the breakdown's heading", () => {
  it("names the rows after the grouping the caller is showing", () => {
    // Fixed, it read "At this moment" — which names the BUCKET, not the column
    // under it, and said the same thing over players, abilities and enemies.
    render(
      <MantineProvider>
        <ChartTooltip
          label="03:03"
          payload={[{ dataKey: "0", name: "0", value: 1, color: "#f00" }]}
          format="amount"
          labels={LABELS}
          sectionKey="ui.logs.rows-by-ability"
        />
      </MantineProvider>
    );
    expect(screen.getByText("ui.logs.rows-by-ability")).toBeTruthy();
    expect(screen.queryByText("ui.logs.chart-tooltip-section")).toBeNull();
  });
});

describe("DpsChart — the capped band tail", () => {
  // The plot itself does not render here (recharts' ResponsiveContainer
  // measures zero in jsdom), but the legend is deliberately in ordinary flow
  // BELOW the chart — so the parts this feature turns on are reachable.
  const BANDS: Label = [
    { name: "s1", label: "Reginleiv", partySlotIndex: 0, color: "#f00" },
    { name: "s2", label: "Miserable Mist", partySlotIndex: 1, color: "#0f0" },
    { name: "t1", label: "Rising Sword", partySlotIndex: 2, color: "#00f", tail: true },
    { name: "t2", label: "Wild Magica", partySlotIndex: 3, color: "#0ff", tail: true },
    { name: "other", label: "Other", partySlotIndex: -1, color: "#999" },
  ];

  const DATA = [
    { timestamp: "00:01", s1: 100, s2: 50, t1: 20, t2: 5 },
    { timestamp: "00:02", s1: 200, s2: 60, t1: 30, t2: 7 },
  ] as unknown as ChartDatapoint[];

  const renderChart = (labels: Label = BANDS) =>
    render(
      <MantineProvider>
        <DpsChart
          data={DATA}
          labels={labels}
          labelKey="ui.logs.chart-dps-label"
          sectionKey="ui.logs.rows-by-ability"
          format="amount"
          onScope={() => {}}
          stacked
        />
      </MantineProvider>
    );

  it("opens with the tail folded away and the rest of the legend listed", () => {
    renderChart();
    expect(screen.getByText("Reginleiv")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.queryByText("Rising Sword")).toBeNull();
  });

  it("greys a revealed tail band rather than plotting it straight away", () => {
    // Hidden by DEFAULT, which is what the reset effect establishes on first
    // paint — the tail is inside Other until the user asks for it.
    const { container } = renderChart();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));

    const entry = container.querySelector<HTMLElement>('[data-legend-key="t1"]')!;
    expect(entry.getAttribute("aria-pressed")).toBe("false");
    expect(entry.querySelector<HTMLElement>("[data-legend-swatch]")!.style.opacity).not.toBe("1");
  });

  it("switches a tail band on, and it stays listed once the tail folds again", () => {
    const { container } = renderChart();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));
    fireEvent.click(screen.getByText("Rising Sword"));

    expect(container.querySelector('[data-legend-key="t1"]')!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-fewer"));
    // Plotted now, so the legend must keep explaining its colour.
    expect(screen.getByText("Rising Sword")).toBeTruthy();
    expect(screen.queryByText("Wild Magica")).toBeNull();
  });

  it("drops the Other entry once the whole tail is switched on", () => {
    // It stands for nothing at that point, and a zeroed band would still take
    // a legend entry and a colour.
    renderChart();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));
    fireEvent.click(screen.getByText("Rising Sword"));
    expect(screen.getByText("Other")).toBeTruthy();

    fireEvent.click(screen.getByText("Wild Magica"));
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("offers no fold control on a chart whose bands all fit the cap", () => {
    renderChart([BANDS[0], BANDS[1]]);
    expect(screen.queryByText("ui.logs.chart-legend-show-more")).toBeNull();
    expect(screen.getByText("Reginleiv")).toBeTruthy();
  });

  it("re-hides the tail when the plotted bands change under a new pin", () => {
    // A legend click must not survive into a chart whose keys differ — and the
    // resting state it returns to is the tail hidden, not everything shown.
    const { rerender, container } = renderChart();
    fireEvent.click(screen.getByText("ui.logs.chart-legend-show-more"));
    fireEvent.click(screen.getByText("Rising Sword"));
    expect(container.querySelector('[data-legend-key="t1"]')!.getAttribute("aria-pressed")).toBe("true");

    rerender(
      <MantineProvider>
        <DpsChart
          data={DATA}
          labels={[...BANDS, { name: "t3", label: "Sword Shower", partySlotIndex: 4, color: "#f0f", tail: true }]}
          labelKey="ui.logs.chart-dps-label"
          sectionKey="ui.logs.rows-by-ability"
          format="amount"
          onScope={() => {}}
          stacked
        />
      </MantineProvider>
    );

    expect(container.querySelector('[data-legend-key="t1"]')!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ChartTooltip — the Ctrl detail modifier", () => {
  /** Ctrl down and up on the window, the way the browser delivers them. */
  const ctrl = (down: boolean) =>
    fireEvent(window, new KeyboardEvent(down ? "keydown" : "keyup", { key: "Control", ctrlKey: down }));

  // Seven bands landing at once — a stacked skill-group plot routinely has
  // more than the section's five-entry cap.
  const BANDS = Array.from({ length: SECTION_ENTRY_CAP + 2 }, (_, i) => ({
    dataKey: String(i),
    name: String(i),
    value: 100 - i,
    color: "#f00",
  }));
  const LANE_LABELS: Label = BANDS.map((band, i) => ({
    name: band.name,
    label: `band ${i}`,
    partySlotIndex: 0,
    color: "#f00",
  }));

  it("reveals the capped tail while Ctrl is held, and hides it again on release", () => {
    // The chart tooltip mounts its body directly rather than through
    // `HoverCard`, so it reads the key itself — otherwise the one card of the
    // three that skips the shell would be the one that never responds.
    renderTooltip(BANDS, LANE_LABELS);
    expect(screen.queryByText(`band ${SECTION_ENTRY_CAP}`)).toBeNull();

    ctrl(true);
    expect(screen.getByText(`band ${SECTION_ENTRY_CAP}`)).toBeTruthy();
    expect(screen.getByText(`band ${SECTION_ENTRY_CAP + 1}`)).toBeTruthy();

    ctrl(false);
    expect(screen.queryByText(`band ${SECTION_ENTRY_CAP}`)).toBeNull();
  });
});

/** The strip above the plot, which holds every control that changes how the
 * chart READS — the smoothing window, the stack mode, the band and marker
 * switches — plus whatever the caller adds to it. */
describe("DpsChart — the header control strip", () => {
  const DATA = [
    { timestamp: "00:01", s1: 100 },
    { timestamp: "00:02", s1: 200 },
  ] as unknown as ChartDatapoint[];

  const SERIES: Label = [{ name: "s1", label: "Reginleiv", partySlotIndex: 0, color: "#f00" }];

  const renderChart = (props: Partial<React.ComponentProps<typeof DpsChart>> = {}) =>
    render(
      <MantineProvider>
        <DpsChart
          data={DATA}
          labels={SERIES}
          labelKey="ui.logs.chart-dps-label"
          sectionKey="ui.logs.rows-by-ability"
          format="amount"
          onScope={() => {}}
          smoothing={1}
          onSmoothingChange={() => {}}
          {...props}
        />
      </MantineProvider>
    );

  const MARKERS = [
    { kind: "death" as const, atMs: 1000, color: "#f00", label: "Rain died" },
    { kind: "sba" as const, atMs: 1500, color: "#0f0", label: "Rain SBA" },
  ];

  // The kind switches are CONTROLLED when the caller owns them, so several
  // plots of one comparison share one set: the split layout draws the same
  // fight twice, and one chart hiding deaths while the other shows them is not
  // one reading.
  it("reports a kind toggle to the caller instead of hiding it itself", () => {
    const onToggleMarkerKind = vi.fn();
    renderChart({
      markers: MARKERS,
      hiddenMarkerKinds: new Set(),
      onToggleMarkerKind,
    });

    fireEvent.click(screen.getByLabelText("ui.logs.chart-marker-deaths"));

    expect(onToggleMarkerKind).toHaveBeenCalledWith("death");
  });

  it("draws the caller's hidden set rather than its own", () => {
    renderChart({
      markers: MARKERS,
      hiddenMarkerKinds: new Set(["death" as const]),
      onToggleMarkerKind: () => {},
    });

    expect(screen.getByLabelText("ui.logs.chart-marker-deaths").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("ui.logs.chart-marker-sba").getAttribute("aria-pressed")).toBe("true");
  });

  // A lone plot still owns its own switches — the control is optional, and
  // without it the chart must keep working on its own.
  it("keeps its own kind state when the caller does not own it", () => {
    renderChart({ markers: MARKERS });

    fireEvent.click(screen.getByLabelText("ui.logs.chart-marker-deaths"));

    expect(screen.getByLabelText("ui.logs.chart-marker-deaths").getAttribute("aria-pressed")).toBe("false");
  });

  /** The caller's own controls belong in the SAME strip as the chart's, not on
   * a row of their own: they are the same kind of thing — a knob that changes
   * the reading — and a second row would push the plot down and split one set
   * of controls across two places. */
  it("puts caller-supplied controls in the same strip as the smoothing window", () => {
    renderChart({ controls: <span>merge-switch</span> });

    const strip = screen.getByTestId("chart-controls");
    expect(strip.contains(screen.getByText("merge-switch"))).toBe(true);
    expect(strip.contains(screen.getByText("ui.logs.chart-smoothing-caption"))).toBe(true);
  });

  it("draws the strip without them when the caller supplies none", () => {
    renderChart();

    expect(screen.queryByText("merge-switch")).toBeNull();
    expect(screen.getByTestId("chart-controls")).toBeTruthy();
  });
});

/** Which "the other log ended here" rules a chart draws. Comparing two runs of
 * different lengths, the shorter one's line simply stops while the longer
 * carries on — which reads as a fight that went quiet rather than one that
 * ended. */
describe("visibleEndLines", () => {
  const line = (bucket: number) => ({ bucket, color: "#abc", label: `#${bucket}` });

  it("draws a rule for a log that ended before this one", () => {
    expect(visibleEndLines([line(3)], 10).map((end) => end.bucket)).toEqual([3]);
  });

  // No "it ended here" to point at, and a clamped rule would sit on the axis
  // edge claiming otherwise.
  it("drops a log that outlasted this one", () => {
    expect(visibleEndLines([line(11)], 10)).toEqual([]);
  });

  // The two runs are the same length: the axis edge already says where both
  // stopped.
  it("drops a log that ended exactly with this one", () => {
    expect(visibleEndLines([line(10)], 10)).toEqual([]);
  });

  // A pane whose chart has not landed publishes a length of 0, so its end
  // arrives as bucket -1.
  it("drops a pane that has not drawn anything yet", () => {
    expect(visibleEndLines([line(-1)], 10)).toEqual([]);
  });

  it("keeps every shorter log, in the order given", () => {
    expect(visibleEndLines([line(7), line(2)], 10).map((end) => end.bucket)).toEqual([7, 2]);
  });
});
