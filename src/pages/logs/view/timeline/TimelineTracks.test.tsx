import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../metrics/types";

import type { Lane } from "./laneMarks";
import { TimelineTracks } from "./TimelineTracks";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const metricRow = (over: Partial<MetricRow>): MetricRow => ({
  key: "",
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

const LANES: Lane[] = [
  {
    row: metricRow({
      key: "skill:Normal:100",
      label: "Normal:100",
      kind: "ability",
      pinOnClick: { ability: "Normal:100" },
    }),
    spans: false,
    marks: [
      {
        startMs: 0,
        endMs: 0,
        count: 1,
        amount: 500,
        by: [{ key: "Normal:100", count: 1, amount: 500 }],
        hits: [{ atMs: 0, echo: false }],
        casts: 1,
        castKey: "damage|Normal:100",
      },
    ],
  },
  {
    row: metricRow({ key: "status:77:210", label: "status:77:210", kind: "status" }),
    spans: true,
    // A real span is not an event fold, so it has no parts to decompose.
    marks: [{ startMs: 5000, endMs: 15_000, count: 1, amount: null, by: [], hits: [], casts: 1, castKey: "" }],
  },
];

const renderTracks = (lanes = LANES, over: Partial<React.ComponentProps<typeof TimelineTracks>> = {}) =>
  render(
    <MantineProvider>
      <TimelineTracks
        lanes={lanes}
        domainMs={30_000}
        startMs={0}
        viewportMs={30_000}
        renderLabel={(row) => `label(${row.key})`}
        rowColor={() => "#36B37E"}
        onPin={() => {}}
        {...over}
      />
    </MantineProvider>
  );

describe("TimelineTracks", () => {
  it("renders one lane per row, in order", () => {
    const { container } = renderTracks();
    const names = [...container.querySelectorAll("[data-lane-names] [role='row']")].map((el) => el.textContent);
    expect(names).toEqual(["label(skill:Normal:100)", "label(status:77:210)"]);
  });

  // The block grows to its full height and the PAGE scrolls it. A `max-height`
  // here is what broke the two columns before: a single-line flex container
  // clamps its line to its own max cross size, so BOTH columns were stretched
  // to the frame's height instead of their content's. The names spilled (they
  // are `overflow: visible`) and scrolled with the frame, while the tracks --
  // forced to `overflow-y: auto` by their own `overflow-x` -- clipped instead,
  // so they kept a second vertical scrollbar and ran out part-way down.
  it("keeps no vertical scroller of its own", () => {
    const { container } = renderTracks();
    const frame = container.querySelector("[role='group']") as HTMLElement;
    expect(frame.className).not.toMatch(/max-h-|overflow-y-auto|overflow-auto/);
  });

  // Only the tracks scroll sideways. Spanning the whole frame, the scrollbar
  // sits under the name column too and reads as if the names scrolled with it.
  it("puts the horizontal scrollbar on the track column only", () => {
    const { container } = renderTracks();
    const scroll = container.querySelector("[data-tracks-scroll]") as HTMLElement;
    expect(scroll.className).toContain("overflow-x-auto");
    // The names column must not sit inside the horizontal scroller...
    expect(container.querySelector("[data-tracks-scroll] [data-lane-names]")).toBeNull();
    // ...and must not scroll on any axis of its own.
    expect((container.querySelector("[data-lane-names]") as HTMLElement).className).not.toContain("overflow");
  });

  it("draws lanes as the table's own row", () => {
    const { container } = renderTracks();
    expect(container.querySelectorAll("[data-lane-names] [role='row']").length).toBe(2);
  });

  // The two columns are rendered from one sequence; if they ever disagree the
  // names sit against the wrong marks.
  it("renders the same number of lane rows in both columns", () => {
    const { container } = renderTracks(LANES, { sectionLabel: () => "S" });
    expect(container.querySelectorAll("[data-lane-names] [role='row']").length).toBe(
      container.querySelectorAll("[data-timeline-content] [data-lane-row]").length
    );
  });

  it("renders the same number of section headings in both columns", () => {
    const { container } = renderTracks(LANES, {
      sectionLabel: (row: MetricRow) => (row.kind === "status" ? "Effects" : "Abilities"),
    });
    expect(container.querySelectorAll("[data-lane-heading]").length).toBe(
      container.querySelectorAll("[data-lane-gap]").length
    );
  });

  it("opens the table's card on a mark that has contributions", () => {
    const { container } = renderTracks(LANES, {
      cardAmount: { amountKey: "ui.logs.column-dmg", format: (value: number) => String(value) },
      markEntry: (key: string) => ({ name: `named(${key})` }),
    });
    // Both marks still draw; the instant one now carries a card.
    expect(container.querySelectorAll("[data-mark]").length).toBe(2);
  });

  // A lane and its table row must not be resolved two ways, so the caller's
  // renderLabel is the only namer.
  it("names lanes through the caller's renderLabel", () => {
    renderTracks();
    expect(screen.getByText("label(skill:Normal:100)")).toBeTruthy();
  });

  it("positions a mark as a percentage of the domain", () => {
    const { container } = renderTracks();
    const spanMark = container.querySelectorAll("[data-mark]")[1] as HTMLElement;
    expect(spanMark.style.left).toBe("16.6667%");
    expect(spanMark.style.width).toBe("33.3333%");
  });

  // The two mark shapes must be distinguishable, or a folded burst of hits
  // reads as a buff that was up for that whole time.
  it("marks a real span and a folded instant with different classes", () => {
    const { container } = renderTracks();
    expect(container.querySelectorAll('[data-mark-kind="instant"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-mark-kind="span"]')).toHaveLength(1);
  });

  // A percentage of the track scroller, which IS the visible track width now
  // that the names sit outside it -- so the scale needs no measurement.
  it("widens the content by domain over viewport", () => {
    const { container } = renderTracks(LANES, { domainMs: 90_000, viewportMs: 30_000 });
    expect((container.querySelector("[data-timeline-content]") as HTMLElement).style.width).toBe("300%");
  });

  // Clicking a lane pins exactly what clicking its table row pins.
  it("pins the row's own pinOnClick when its name is clicked", () => {
    const onPin = vi.fn();
    renderTracks(LANES, { onPin });
    fireEvent.click(screen.getByText("label(skill:Normal:100)"));
    expect(onPin).toHaveBeenCalledWith({ ability: "Normal:100" });
  });

  it("does not pin for a lane whose row is a leaf", () => {
    const onPin = vi.fn();
    renderTracks(LANES, { onPin });
    fireEvent.click(screen.getByText("label(status:77:210)"));
    expect(onPin).not.toHaveBeenCalled();
  });

  it("draws a section subheader when the section changes between lanes", () => {
    renderTracks(LANES, { sectionLabel: (row) => (row.kind === "status" ? "Effects" : "Abilities") });
    expect(screen.getByText("Abilities")).toBeTruthy();
    expect(screen.getByText("Effects")).toBeTruthy();
  });

  it("shows the empty state when there are no lanes", () => {
    renderTracks([]);
    expect(screen.getByText("ui.logs.timeline-empty")).toBeTruthy();
  });
});

describe("cast ticks", () => {
  /** One cast holding `hits` hits, every third of them an echo. */
  const castLane = (hits: number): Lane => ({
    row: metricRow({ key: "a", label: "A", value: 1, colorSlot: 0 }),
    spans: false,
    marks: [
      {
        startMs: 0,
        endMs: 2_000,
        count: hits,
        amount: 100 * hits,
        by: [{ key: "Normal:100", count: hits, amount: 100 * hits }],
        hits: Array.from({ length: hits }, (_, index) => ({ atMs: index * 100, echo: index % 3 === 0 })),
        casts: 1,
        castKey: "damage|Normal:100",
      },
    ],
  });

  it("draws a tick per hit inside a cast", () => {
    renderTracks([castLane(5)]);
    expect(screen.getAllByTestId("timeline-tick")).toHaveLength(5);
  });

  it("marks an echo tick so it can read fainter", () => {
    renderTracks([castLane(5)]);
    const echoes = screen.getAllByTestId("timeline-tick").filter((tick) => tick.hasAttribute("data-echo"));
    expect(echoes).toHaveLength(2);
  });

  it("draws a dense cast solid rather than as mush", () => {
    renderTracks([castLane(60)]);
    expect(screen.queryAllByTestId("timeline-tick")).toHaveLength(0);
  });
});
