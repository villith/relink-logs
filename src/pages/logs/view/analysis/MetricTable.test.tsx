import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../metrics/types";

import { MetricTable } from "./MetricTable";
import type { RowPresentation } from "./model/bodyContext";

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
    expect(container.querySelectorAll("[data-band-toggle]")).toHaveLength(0);
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

    const toggles = container.querySelectorAll("[data-band-toggle]");
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
    expect(container.querySelectorAll("[data-band-toggle]")).toHaveLength(0);
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

    const toggles = container.querySelectorAll("[data-band-toggle]");
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
    const bars = container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']");
    expect(bars[0].style.width).toBe("100%");
    expect(parseFloat(bars[1].style.width)).toBeCloseTo(100 / 3, 6);
  });

  it("draws a row's supplementary split", () => {
    renderTable({
      rows: [{ key: "a", label: "A", value: 50, subValue: 20, columns: [], pinOnClick: null, colorSlot: 0 }],
    });
    const segments = screen.getAllByTestId("metric-bar-segment") as HTMLElement[];
    expect(segments).toHaveLength(2);
    expect(segments[1].style.left).toBe("60%");
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
    const bar = container.querySelector<HTMLElement>("[data-testid='metric-bar-segment']");
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
    const bars = container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']");
    expect(bars).toHaveLength(2);
    expect(bars[0].style.width).toBe("0%");
  });

  it("uses the caller's name renderer when one is given", () => {
    renderTable({ rowName: (row: MetricRow) => `<${row.key}>` });
    expect(screen.getByText("<a>")).toBeTruthy();
  });

  it("names its rows off a whole RowPresentation, the way the view hands it one", () => {
    // The view renders `<MetricTable {...presentation} />`, and a spread is
    // checked only for the props the table DECLARES: when this table read the
    // presentation's namer under a name of its own (`renderName`), nothing
    // failed to compile — every row silently fell back to its raw `label` and
    // the table drew "Normal:1100" where a skill name belongs. Typing the
    // fixture as the contract is what makes a future rename fail HERE.
    const presentation: RowPresentation = {
      rows: ROWS,
      rowKind: "player",
      rowName: (row) => `name(${row.key})`,
      rowArt: () => undefined,
      renderLabel: (row) => `label(${row.key})`,
      rowColor: () => "#36B37E",
      onPin: () => {},
    };
    render(
      <MantineProvider>
        <MetricTable {...presentation} columnKeys={[]} />
      </MantineProvider>
    );
    expect(screen.getByText("name(a)")).toBeTruthy();
    expect(screen.queryByText("Narmaya")).toBeNull();
  });

  it("draws a row's art at bar height, and notches the bar it nests into", () => {
    const { container } = renderTable({ rowArt: (row) => (row.key === "a" ? "/art/a.png" : undefined) });

    const art = container.querySelectorAll<HTMLImageElement>("img");
    expect(art).toHaveLength(1);
    expect(art[0].getAttribute("src")).toBe("/art/a.png");
    expect(art[0].className).toContain("size-art");

    // The row the game draws no picture for still holds the box, so the name
    // column's left edge does not move from row to row — and so the bite the
    // bar has taken out of itself is not left standing empty.
    expect(container.querySelectorAll("[data-row-art-empty]")).toHaveLength(1);

    // Every bar is bitten and anchored to the art's centre, art or none.
    const bars = container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']");
    expect(bars).toHaveLength(2);
    for (const bar of bars) expect(bar.style.clipPath).toContain("polygon");
  });

  it("heads an actor's bar itself rather than biting a notch for art that cannot fill it", () => {
    // A character bust is not a diamond: a bite cut for one would open a hole
    // around the bust instead of seating it, and would put the page's ground
    // behind the character where the row's own colour belongs. The bar draws
    // the diamond's head instead and the bust stands on it — same silhouette.
    const { container } = renderTable({ rowKind: "player", rowArt: () => "/art/gran.png" });
    const bars = container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']");
    for (const bar of bars) expect(bar.style.clipPath).toContain("polygon");
    // Reaching back to the art's LEFT EDGE, not its centre: the head has to
    // cover the box the bust stands in.
    expect(container.querySelector<HTMLElement>("[data-bar-track]")?.className).toContain("left-[var(--row-pad)]");
    // The art is still drawn at the bar's own height.
    expect(container.querySelector("img")?.className).toContain("size-art");
  });

  it("takes a row's own kind over the table's when deciding how the bar meets it", () => {
    const mixed: MetricRow[] = [
      { ...ROWS[0], kind: "player" },
      { ...ROWS[1], kind: "ability" },
    ];
    const { container } = renderTable({ rows: mixed, rowKind: "player", rowArt: () => "/art/a.png" });
    const tracks = container.querySelectorAll<HTMLElement>("[data-bar-track]");
    expect(tracks[0].className).toContain("left-[var(--row-pad)]");
    expect(tracks[1].className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]");
  });

  it("stands the row's rectangular outline down where the bar draws a shaped ring", () => {
    const { container } = renderTable({ rowArt: () => "/art/a.png" });
    const row = container.querySelector<HTMLElement>("[role='row']:not([data-head])");
    expect(row?.className).toContain("group");
    expect(row?.className).not.toContain("hover:outline");
    expect(container.querySelectorAll("[data-bar-ring]")).toHaveLength(2);
  });

  it("leaves the bar square when the caller draws no art", () => {
    const { container } = renderTable();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const bar = container.querySelector<HTMLElement>("[data-testid='metric-bar-segment']");
    expect(bar?.style.clipPath).toBe("");
  });

  it("moves an indented row's own padding, so its art and its bar's bite travel together", () => {
    // The bar's notch is anchored to `--row-pad` (see `MetricBar`); a subrow
    // that indented with a `pl-*` of its own would leave the bite behind at the
    // row's edge, a whole indent to the left of the diamond it is cut for.
    const parent: MetricRow = { ...ROWS[0], children: [ROWS[1], { ...ROWS[1], key: "c" }] };
    const { container } = renderTable({ rows: [parent] });
    fireEvent.click(container.querySelector("[data-expand]")!);
    const subrow = container.querySelector<HTMLElement>("[data-subrow]");
    expect(subrow?.className).toContain("[--row-pad:calc(28px*var(--density))]");
  });

  it("names what the rows are", () => {
    renderTable({ rowsLabelKey: "ui.logs.rows-by-player" });
    expect(screen.getByText("ui.logs.rows-by-player")).toBeTruthy();
  });

  const SECTIONS = () => [
    {
      headingKey: "ui.logs.hover-by-target",
      color: "rgb(1,2,3)",
      entries: [{ key: "t", label: "Boss", value: 5 }],
    },
  ];
  const CARD_AMOUNT = { amountKey: "ui.meter-columns.damage", format: (value: number) => String(value) };

  it("wraps a row in a hover card when the caller supplies sections", () => {
    const { container } = renderTable({ rowSections: SECTIONS, cardAmount: CARD_AMOUNT });
    // The column head also carries role="row" (a grid's header row is a row),
    // so a data row is one that is not the head.
    const row = container.querySelector<HTMLElement>("[role='row']:not([data-head])");
    expect(row).toBeTruthy();
    fireEvent.mouseOver(row!);
    expect(screen.getByTestId("metric-hover-card")).toBeTruthy();
    expect(screen.getByText("Boss")).toBeTruthy();
  });

  it("renders no card for sections with no stated meaning", () => {
    // `cardAmount` says what the figures ARE. Defaulting it is how every tab's
    // tooltip came to head its column "DMG" and report damage; without one
    // there is nothing honest to draw.
    const { container } = renderTable({ rowSections: SECTIONS });
    fireEvent.mouseOver(container.querySelector<HTMLElement>("[role='row']:not([data-head])")!);
    expect(screen.queryByTestId("metric-hover-card")).toBeNull();
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

    const toggle = container.querySelector("[data-band-toggle]");
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

    const toggle = container.querySelector("[data-band-toggle]");
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("subrows", () => {
  const child = (key: string, value: number): MetricRow => ({
    key,
    label: key,
    value,
    columns: [String(value), ""],
    pinOnClick: { ability: key },
    colorSlot: 0,
  });

  const parentRows = (): MetricRow[] => [
    {
      key: "skill:group",
      label: "skill:group",
      value: 400,
      columns: ["400", "4"],
      pinOnClick: { ability: "group" },
      colorSlot: 0,
      children: [child("skill:Normal:100", 300), child("skill:Normal:110", 100)],
    },
    {
      key: "skill:Normal:999",
      label: "skill:Normal:999",
      value: 50,
      columns: ["50", "1"],
      pinOnClick: null,
      colorSlot: 0,
    },
  ];

  it("renders an expand control only on rows with children", () => {
    const { container } = renderTable({ rows: parentRows() });
    const chevrons = container.querySelectorAll("[data-expand]");
    expect(chevrons).toHaveLength(1);
    expect(chevrons[0].getAttribute("aria-label")).toBe("ui.logs.expand-row");
    expect(chevrons[0].tagName).toBe("BUTTON");
  });

  it("reveals the children as indented rows on expand, without pinning the parent", () => {
    const onPin = vi.fn();
    const { container } = renderTable({ rows: parentRows(), onPin });

    expect(screen.queryByText("skill:Normal:100")).toBeNull();

    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(onPin).not.toHaveBeenCalled();

    expect(screen.getByText("skill:Normal:100")).toBeTruthy();
    expect(screen.getByText("skill:Normal:110")).toBeTruthy();
    expect(container.querySelectorAll("[data-subrow]")).toHaveLength(2);
  });

  it("pins a clicked child by the child's own payload", () => {
    const onPin = vi.fn();
    const { container } = renderTable({ rows: parentRows(), onPin });
    fireEvent.click(container.querySelector("[data-expand]")!);

    screen.getByText("skill:Normal:110").click();
    expect(onPin).toHaveBeenCalledWith({ ability: "skill:Normal:110" });
  });

  it("collapses again on a second click", () => {
    const { container } = renderTable({ rows: parentRows() });
    const chevron = container.querySelector("[data-expand]")!;
    fireEvent.click(chevron);
    fireEvent.click(chevron);
    expect(screen.queryByText("skill:Normal:100")).toBeNull();
  });

  it("resets expansion when the rows change identity", () => {
    const { container, rerender } = renderTable({ rows: parentRows() });
    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(screen.getByText("skill:Normal:100")).toBeTruthy();

    // A regroup or refetch hands the table a NEW rows array; stale expansion
    // keyed to the old rows must not leak onto it.
    rerender(
      <MantineProvider>
        <MetricTable
          rows={parentRows()}
          columnKeys={["ui.logs.total-damage", "ui.meter-columns.dps"]}
          onPin={() => {}}
        />
      </MantineProvider>
    );
    expect(screen.queryByText("skill:Normal:100")).toBeNull();
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

    const pieces = container.querySelectorAll<HTMLElement>("[data-uptime-piece]");
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

    expect(container.querySelectorAll("[data-uptime-piece]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='metric-bar-segment']")).toHaveLength(1);
  });

  it("gives a zero-width window a visible minimum rather than nothing", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 5_000, endMs: 5_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    const piece = container.querySelector<HTMLElement>("[data-uptime-piece]");
    expect(piece?.style.minWidth).toBe("2px");
  });

  it("falls back to the magnitude bar when the window has no length", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 0, endMs: 1_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 0,
    });

    expect(container.querySelectorAll("[data-uptime-piece]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='metric-bar-segment']")).toHaveLength(1);
  });

  it("draws the pieces inside a dedicated track cell, not across the row", () => {
    const { container } = renderTable({
      rows: [row({ timeline: [{ startMs: 0, endMs: 2_000 }] })],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    const track = container.querySelector("[data-uptime-track]") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track.querySelectorAll("[data-uptime-piece]")).toHaveLength(1);
    // The name cell is bounded so the track never sits under the text.
    const nameClasses = container.querySelector("[role='gridcell']")?.className.split(" ") ?? [];
    expect(nameClasses).toContain("basis-name");
  });

  it("keeps the magnitude rows' name cell fluid", () => {
    const { container } = renderTable({
      rows: [row()],
      columnKeys: ["ui.logs.buff-uptime"],
      timelineMs: 10_000,
    });

    const nameClasses = container.querySelector("[role='gridcell']")?.className.split(" ") ?? [];
    expect(nameClasses).not.toContain("basis-name");
    expect(container.querySelector("[data-uptime-track]")).toBeNull();
  });
});

describe("children accessor", () => {
  const child = (key: string, value: number): MetricRow => ({
    key,
    label: key,
    value,
    columns: [String(value), ""],
    pinOnClick: null,
    colorSlot: 0,
  });

  const parent = (children?: MetricRow[]): MetricRow => ({
    key: "skill:parent",
    label: "skill:parent",
    value: 100,
    columns: ["100", "1"],
    pinOnClick: null,
    colorSlot: 0,
    ...(children ? { children } : {}),
  });

  it("prefers the accessor's children over the row's own", () => {
    // Party-wide, the per-source split REPLACES the member variants the
    // groups fetch attached — the spec's two reading modes.
    const { container } = renderTable({
      rows: [parent([child("skill:member", 40), child("skill:member2", 60)])],
      rowChildren: () => [child("player:0", 70), child("player:1", 30)],
    });
    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(screen.getByText("player:0")).toBeTruthy();
    expect(screen.queryByText("skill:member")).toBeNull();
  });

  it("falls back to the row's own children when the accessor answers null", () => {
    // The drilled case: a pinned source's parent carries its member variants.
    const { container } = renderTable({
      rows: [parent([child("skill:member", 40), child("skill:member2", 60)])],
      rowChildren: () => null,
    });
    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(screen.getByText("skill:member")).toBeTruthy();
  });

  it("hides the chevron below two children — one child only restates its parent", () => {
    const { container } = renderTable({
      rows: [parent()],
      rowChildren: () => [child("player:0", 100)],
    });
    expect(container.querySelectorAll("[data-expand]")).toHaveLength(0);
  });

  it("falls back to the row's own children when the accessor's split restates the parent", () => {
    // A character-unique ability has ONE user, so the per-source split is a
    // single row — which the ≥2 rule then refuses to draw a chevron for. Left
    // to shadow the member variants it would hide an expansion that did have
    // something to say, on every ability row of a solo log.
    const { container } = renderTable({
      rows: [parent([child("skill:member", 40), child("skill:member2", 60)])],
      rowChildren: () => [child("player:0", 100)],
    });
    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(screen.getByText("skill:member")).toBeTruthy();
    expect(screen.queryByText("player:0")).toBeNull();
  });

  it("reports its open state to assistive tech", () => {
    const { container } = renderTable({
      rows: [parent()],
      rowChildren: () => [child("player:0", 70), child("player:1", 30)],
    });
    const chevron = container.querySelector("[data-expand]")!;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
  });

  it("gives accessor children the subrow anatomy", () => {
    const { container } = renderTable({
      rows: [parent()],
      rowChildren: () => [child("player:0", 70), child("player:1", 30)],
    });
    fireEvent.click(container.querySelector("[data-expand]")!);
    expect(container.querySelectorAll("[data-subrow]")).toHaveLength(2);
  });
});

describe("section subheaders", () => {
  const sectioned: MetricRow[] = [
    { key: "a", label: "a", value: 3, columns: ["3"], pinOnClick: null, colorSlot: -1 },
    { key: "b", label: "b", value: 2, columns: ["2"], pinOnClick: null, colorSlot: -1 },
    { key: "c", label: "c", value: 1, columns: ["1"], pinOnClick: null, colorSlot: -1 },
  ];

  it("draws one muted header per section change, not per row", () => {
    renderTable({
      rows: sectioned,
      columnKeys: ["ui.logs.buff-uptime"],
      sectionLabel: (row) => (row.key === "c" ? "Unknown" : "Skill"),
    });
    // Two runs → two headers: Skill above a, Unknown above c — none above b.
    expect(screen.getAllByText("Skill")).toHaveLength(1);
    expect(screen.getAllByText("Unknown")).toHaveLength(1);
  });

  it("draws no headers without the prop — every other table is untouched", () => {
    renderTable({ rows: sectioned, columnKeys: ["ui.logs.buff-uptime"] });
    expect(screen.queryByText("Skill")).toBeNull();
  });
});
