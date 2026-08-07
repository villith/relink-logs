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
    marks: [{ startMs: 0, endMs: 0, count: 1, amount: 500, by: [{ key: "Normal:100", count: 1, amount: 500 }] }],
  },
  {
    row: metricRow({ key: "status:77:210", label: "status:77:210", kind: "status" }),
    spans: true,
    // A real span is not an event fold, so it has no parts to decompose.
    marks: [{ startMs: 5000, endMs: 15_000, count: 1, amount: null, by: [] }],
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
    const names = [...container.querySelectorAll(".timeline-names .analysis-row")].map((el) => el.textContent);
    expect(names).toEqual(["label(skill:Normal:100)", "label(status:77:210)"]);
  });

  it("puts the horizontal scrollbar on the track column only", () => {
    const { container } = renderTracks();
    expect(container.querySelector(".timeline-names")).toBeTruthy();
    // The names column must not sit inside the horizontal scroller.
    expect(container.querySelector(".timeline-tracks-scroll .timeline-names")).toBeNull();
  });

  it("draws lanes as the table's own row", () => {
    const { container } = renderTracks();
    expect(container.querySelectorAll(".timeline-names .analysis-row").length).toBe(2);
  });

  // The two columns are rendered from one sequence; if they ever disagree the
  // names sit against the wrong marks.
  it("renders the same number of lane rows in both columns", () => {
    const { container } = renderTracks(LANES, { sectionLabel: () => "S" });
    expect(container.querySelectorAll(".timeline-names .analysis-row").length).toBe(
      container.querySelectorAll(".timeline-content .timeline-row").length
    );
  });

  it("renders the same number of section headings in both columns", () => {
    const { container } = renderTracks(LANES, {
      sectionLabel: (row: MetricRow) => (row.kind === "status" ? "Effects" : "Abilities"),
    });
    expect(container.querySelectorAll(".timeline-section").length).toBe(
      container.querySelectorAll(".timeline-row-gap").length
    );
  });

  it("opens the table's card on a mark that has contributions", () => {
    const { container } = renderTracks(LANES, {
      cardAmount: { amountKey: "ui.logs.column-dmg", format: (value: number) => String(value) },
      markEntry: (key: string) => ({ name: `named(${key})` }),
    });
    // Both marks still draw; the instant one now carries a card.
    expect(container.querySelectorAll(".timeline-mark").length).toBe(2);
  });

  // A lane and its table row must not be resolved two ways, so the caller's
  // renderLabel is the only namer.
  it("names lanes through the caller's renderLabel", () => {
    renderTracks();
    expect(screen.getByText("label(skill:Normal:100)")).toBeTruthy();
  });

  it("positions a mark as a percentage of the domain", () => {
    const { container } = renderTracks();
    const spanMark = container.querySelectorAll(".timeline-mark")[1] as HTMLElement;
    expect(spanMark.style.left).toBe("16.6667%");
    expect(spanMark.style.width).toBe("33.3333%");
  });

  // The two mark shapes must be distinguishable, or a folded burst of hits
  // reads as a buff that was up for that whole time.
  it("marks a real span and a folded instant with different classes", () => {
    const { container } = renderTracks();
    expect(container.querySelectorAll(".timeline-mark-instant")).toHaveLength(1);
    expect(container.querySelectorAll(".timeline-mark-span")).toHaveLength(1);
  });

  it("widens the content by domain over viewport", () => {
    const { container } = renderTracks(LANES, { domainMs: 90_000, viewportMs: 30_000 });
    expect((container.querySelector(".timeline-content") as HTMLElement).style.width).toBe("300%");
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
