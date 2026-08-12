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
    shape: "icons",
    marks: [
      {
        startMs: 0,
        endMs: 0,
        count: 1,
        amount: 500,
        by: [{ key: "Normal:100", count: 1, amount: 500 }],
        hits: [{ atMs: 0, echo: false, amount: 500, key: "Normal:100" }],
        casts: 1,
        castKey: "damage|Normal:100",
      },
    ],
  },
  {
    row: metricRow({ key: "status:77:210", label: "status:77:210", kind: "status" }),
    shape: "spans",
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
        gapMs={100}
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

  // The mark shapes must be distinguishable, or a burst of hits reads as a
  // buff that was up for that whole time.
  it("marks a real span and a bucket with different kinds", () => {
    const { container } = renderTracks();
    expect(container.querySelectorAll('[data-mark-kind="bucket"]')).toHaveLength(1);
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

describe("buckets and their hit arrows", () => {
  /** One 2s bucket holding `hits` evenly spread hits, every third an echo. */
  const bucketLane = (hits: number, shape: Lane["shape"] = "buckets"): Lane => ({
    row: metricRow({ key: "a", label: "A", value: 1, colorSlot: 0, kind: "player" }),
    shape,
    marks: [
      {
        startMs: 0,
        endMs: 2_000,
        count: hits,
        amount: 100 * hits,
        by: [{ key: "Normal:100", count: hits, amount: 100 * hits }],
        hits: Array.from({ length: hits }, (_, index) => ({
          atMs: (index * 2000) / (hits - 1),
          echo: index % 3 === 0,
          amount: 100,
          key: "Normal:100",
        })),
        casts: 1,
        castKey: "damage|Normal:100",
      },
    ],
  });

  // ONE bar for the run, however many hits it holds — nothing about the bucket
  // varies with what it contains.
  it("draws one bar per bucket, not per hit", () => {
    const { container } = renderTracks([bucketLane(5)], { gapMs: 100 });
    expect(container.querySelectorAll('[data-mark-kind="bucket"]')).toHaveLength(1);
  });

  it("points an arrow at every hit that can be told apart", () => {
    const { container } = renderTracks([bucketLane(5)], { gapMs: 100 });
    expect(container.querySelectorAll("[data-hit]")).toHaveLength(5);
  });

  // The wedges failed because a 7px marker was drawn in a 3px gap. An arrow is
  // thinned by its OWN width, so a burst too dense to separate simply claims
  // fewer hits rather than drawing a barcode.
  it("thins arrows that would overlap rather than stacking them", () => {
    const { container } = renderTracks([bucketLane(60)], { gapMs: 100 });
    const arrows = container.querySelectorAll("[data-hit]");
    expect(arrows.length).toBeGreaterThan(1);
    expect(arrows.length).toBeLessThan(10);
  });

  // `gapMs` is zero until the tracks have been measured. A zero clearance tells
  // every hit apart, so the first commit of a long fight mounted one hoverable
  // node per damage event in the window.
  it("draws no arrows until the tracks have been measured", () => {
    const { container } = renderTracks([bucketLane(60)], { gapMs: 0 });
    expect(container.querySelectorAll("[data-hit]")).toHaveLength(0);
  });

  // An arrow is drawn ABOVE its own lane, over the neighbour's bar. Clipped to
  // its own silhouette it takes the pointer only where it is actually drawn; as
  // a rectangle its corners stole the hover from the bucket beside it, which
  // both showed the wrong tooltip and tore down that bucket's own card.
  it("takes the pointer only where the arrow itself is drawn", () => {
    const { container } = renderTracks([bucketLane(5)], { gapMs: 100 });
    const arrow = container.querySelector<HTMLElement>("[data-hit]");
    expect(arrow?.style.clipPath).toContain("polygon");
  });

  it("marks an echo's arrow so it can read fainter", () => {
    const { container } = renderTracks([bucketLane(5)], { gapMs: 100 });
    expect(container.querySelectorAll("[data-hit][data-echo]")).toHaveLength(2);
  });

  // The arrows sit in a layer over the whole lane; if that layer took pointer
  // events it would swallow every bucket's own hover.
  it("keeps the arrow layer from swallowing the bucket's hover", () => {
    const { container } = renderTracks([bucketLane(5)], { gapMs: 100 });
    const layer = container.querySelector("[data-hit]")?.parentElement;
    expect(layer?.className).toContain("pointer-events-none");
    expect((container.querySelector("[data-hit]") as HTMLElement).className).toContain("pointer-events-auto");
  });

  // Only an ability lane can name its marks with art: every bucket in a
  // player's lane is a different skill.
  it("draws the skill's own art on an ability lane and not on an actor lane", () => {
    const markEntry = () => ({ name: "Sword Strike", iconUrl: "sword.png" });
    const withArt = renderTracks([bucketLane(3, "icons")], { gapMs: 100, markEntry });
    expect(withArt.container.querySelectorAll("[data-mark-icon]")).toHaveLength(1);
    withArt.unmount();
    const withoutArt = renderTracks([bucketLane(3, "buckets")], { gapMs: 100, markEntry });
    expect(withoutArt.container.querySelectorAll("[data-mark-icon]")).toHaveLength(0);
  });

  // The notch used to be capped at a share of the bar so a stub could not be
  // eaten, which is the same trade `MetricBar` made and undid: at a stub depth
  // the bite no longer matches the diamond that nests in it, and the bar's
  // colour shows through the art's transparent corners. Floor the bar instead.
  it("keeps a bucket that carries art wide enough for its whole notch", () => {
    const markEntry = () => ({ name: "Sword Strike", iconUrl: "sword.png" });
    const { container } = renderTracks([bucketLane(3, "icons")], { gapMs: 100, markEntry });
    const mark = container.querySelector<HTMLElement>('[data-mark-kind="bucket"]');
    expect(parseFloat(mark!.style.minWidth)).toBeGreaterThanOrEqual(24);
    const bar = mark!.firstElementChild as HTMLElement;
    expect(bar.style.clipPath).toContain("20px");
    expect(bar.style.clipPath).not.toContain("35%");
  });

  // A bar with nothing standing at it is square-ended, so it has no head to
  // protect and keeps the readable minimum a single hit has always drawn at.
  it("leaves a headless bucket at its own minimum", () => {
    const { container } = renderTracks([bucketLane(3)], { gapMs: 100 });
    const mark = container.querySelector<HTMLElement>('[data-mark-kind="bucket"]');
    expect(mark!.style.minWidth).toBe("4px");
  });
});
