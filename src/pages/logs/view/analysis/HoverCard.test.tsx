import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoverCard, HoverCardBody, SECTION_ENTRY_CAP, type CardSection } from "./HoverCard";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const section = (headingKey: string, count: number): CardSection => ({
  headingKey,
  color: "rgb(1, 2, 3)",
  entries: Array.from({ length: count }, (_, i) => ({
    key: `e${i}`,
    label: `entry ${i}`,
    value: count - i,
  })),
});

/** What the card measures. Damage's own, since these cases are about layout
 * rather than about which metric is on screen — see the amount-column case. */
const DAMAGE_AMOUNT = { amountKey: "ui.meter-columns.damage", format: (value: number) => String(value) };

const renderBody = (sections: CardSection[], amount = DAMAGE_AMOUNT) =>
  render(
    <MantineProvider>
      <HoverCardBody sections={sections} {...amount} />
    </MantineProvider>
  );

describe("HoverCardBody", () => {
  it("renders a heading per section", () => {
    renderBody([section("ui.logs.hover-by-ability", 2), section("ui.logs.hover-by-target", 1)]);
    expect(screen.getByText("ui.logs.hover-by-ability")).toBeTruthy();
    expect(screen.getByText("ui.logs.hover-by-target")).toBeTruthy();
  });

  it("heads the amount column with what the card is measuring", () => {
    // Hard-coded to "DMG", this heading sat over the Stun tab's figures too.
    renderBody([section("ui.logs.hover-by-ability", 1)], {
      amountKey: "ui.skill-columns.stun",
      format: (value: number) => value.toFixed(1),
    });

    expect(screen.getByText("ui.skill-columns.stun")).toBeTruthy();
    expect(screen.queryByText("ui.meter-columns.damage")).toBeNull();
  });

  it("writes each amount in the metric's own format", () => {
    renderBody([section("ui.logs.hover-by-ability", 1)], {
      amountKey: "ui.skill-columns.stun",
      format: (value: number) => value.toFixed(1),
    });

    expect(screen.getByText("1.0")).toBeTruthy();
  });

  it("caps a section at its top entries, silently — WCL's behavior", () => {
    // No "+N more" row: the entry past the cap and everything below it
    // simply do not render.
    renderBody([section("ui.logs.hover-by-ability", SECTION_ENTRY_CAP + 1)]);
    expect(screen.getByText(`entry ${SECTION_ENTRY_CAP - 1}`)).toBeTruthy();
    expect(screen.queryByText(`entry ${SECTION_ENTRY_CAP}`)).toBeNull();
  });

  it("keeps shares computed over the FULL total, never the shown five", () => {
    // values 6..1 sum to 21. The largest entry's share is 6/21 = 28.6%;
    // re-normalizing over the visible five (6/20 = 30.0%) would silently
    // claim the section sums to 100%.
    renderBody([section("ui.logs.hover-by-target", 6)]);
    expect(screen.getByText("28.6%")).toBeTruthy();
    expect(screen.queryByText("30.0%")).toBeNull();
  });

  it("scales bars against the section's largest entry", () => {
    // Scaling to the section total would draw a three-row target list as three
    // slivers.
    const { container } = renderBody([section("ui.logs.hover-by-target", 4)]);
    const bars = container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']");
    expect(bars[0].style.width).toBe("100%");
    expect(bars[3].style.width).toBe("25%");
  });

  it("draws a card entry's supplementary split the way a table row does", () => {
    renderBody([
      {
        headingKey: "heading",
        color: "red",
        entries: [{ key: "a", label: "Ability", value: 50, subValue: 20 }],
      },
    ]);
    const segments = screen.getAllByTestId("metric-bar-segment") as HTMLElement[];
    // The lone entry IS the section's largest, so the pair fills the track:
    // direct 30/50, supplementary 20/50 picking up exactly where it ends.
    expect(segments).toHaveLength(2);
    expect(segments[0].style.width).toBe("60%");
    expect(segments[1].style.width).toBe("40%");
    expect(segments[1].style.left).toBe("60%");
  });

  it("states each entry's share of the hovered row", () => {
    renderBody([section("ui.logs.hover-by-target", 4)]);
    // values 4,3,2,1 sum to 10
    expect(screen.getByText("40.0%")).toBeTruthy();
    expect(screen.getByText("10.0%")).toBeTruthy();
  });

  it("puts the amount before the share, in both the head and the rows", () => {
    // The amount is what the row is about; the share qualifies it. Reading
    // "% then DMG" put the qualifier first, and disagreed with the table above,
    // where share is the last column.
    const { container } = renderBody([section("ui.logs.hover-by-target", 2)]);

    const head = container.querySelector("[data-card-head]")!.textContent;
    expect(head!.indexOf("ui.meter-columns.damage")).toBeLessThan(head!.indexOf("ui.logs.column-share"));

    const row = container.querySelector("[data-card-row]")!;
    const cells = [...row.querySelectorAll("[data-card-amount], [data-card-share]")];
    expect(cells[0].hasAttribute("data-card-amount")).toBe(true);
    expect(cells[1].hasAttribute("data-card-share")).toBe(true);
  });

  it("skips a section with no entries rather than drawing an empty heading", () => {
    renderBody([section("ui.logs.hover-by-ability", 0), section("ui.logs.hover-by-target", 1)]);
    expect(screen.queryByText("ui.logs.hover-by-ability")).toBeNull();
    expect(screen.getByText("ui.logs.hover-by-target")).toBeTruthy();
  });
});

describe("HoverCardBody — a section that states no shares", () => {
  // A one-row Total section is the case: its share of itself is 100% by
  // construction, and a column that can only ever read 100% is noise.
  const total = (): CardSection => ({
    headingKey: "ui.logs.chart-total-label",
    color: "rgb(9, 9, 9)",
    entries: [{ key: "total", label: "Total", value: 2900 }],
    showShare: false,
  });

  it("drops the share column from the rows", () => {
    const { container } = renderBody([total()]);
    expect(container.querySelector("[data-card-share]")).toBeNull();
    // The amount is the whole point of the row and must survive.
    expect(screen.getByText("2900")).toBeTruthy();
  });

  it("drops the share column from the heading too, so the columns still line up", () => {
    const { container } = renderBody([total()]);
    const head = container.querySelector("[data-card-head]")!.textContent;
    expect(head).not.toContain("ui.logs.column-share");
    expect(head).toContain("ui.meter-columns.damage");
  });

  it("keeps its amount in the same column as the breakdown's amounts", () => {
    // The share cell is a fixed 52px at the END of a flex row, so simply
    // dropping it slides the amount 52px right — the Total would then sit
    // under the share column of every row it sums. The width is reserved
    // instead, so the two amounts still read down one column.
    const { container } = renderBody([section("ui.logs.hover-by-target", 2), total()]);
    const rows = [...container.querySelectorAll("[data-card-row]")];
    /** Which cell each of a row's children is, by the hook it carries. */
    const cellKinds = (row: Element) =>
      [...row.children].map(
        (cell) => [...cell.attributes].map((attr) => attr.name).find((name) => name.startsWith("data-card-")) ?? ""
      );

    // The amount sits at the same offset from the end of both rows, with a
    // cell of the share column's own width trailing it either way.
    expect(cellKinds(rows[0]).at(-2)).toBe("data-card-amount");
    expect(cellKinds(rows[2]).at(-2)).toBe("data-card-amount");
    expect(cellKinds(rows[2]).at(-1)).toBe("data-card-share-spacer");
    // The reserved width has to be the share column's OWN rather than a second
    // literal free to drift from it. jsdom loads no stylesheet, so compare the
    // width utility the two cells carry.
    const widthOf = (cell: Element) => [...cell.classList].find((name) => name.startsWith("w-["));
    expect(widthOf([...rows[2].children].at(-1)!)).toBe(widthOf(container.querySelector("[data-card-share]")!));
  });

  it("leaves a section that says nothing about shares untouched elsewhere", () => {
    // The flag is per SECTION: a card can carry both, and the breakdown beside
    // a Total must keep its own percentages.
    const { container } = renderBody([section("ui.logs.hover-by-target", 2), total()]);
    expect(container.querySelectorAll("[data-card-share]")).toHaveLength(2);
  });
});

describe("HoverCardBody — a section that states no heading", () => {
  const headless = (): CardSection => ({
    headingKey: "ui.logs.chart-total-label",
    color: "rgb(9, 9, 9)",
    entries: [{ key: "total", label: "Total", value: 5 }],
    showHeading: false,
  });

  it("renders the rows with no heading row above them", () => {
    // The section separator already divides it from the breakdown, and a
    // heading reading "Total" over a single row labelled "Total" says it twice.
    const { container } = renderBody([section("ui.logs.hover-by-target", 1), headless()]);
    expect(screen.queryByText("ui.logs.chart-total-label")).toBeNull();
    expect(screen.getByText("Total")).toBeTruthy();
    // Still its own section, so the separator between the two survives.
    expect(container.querySelectorAll("[data-card-section]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-card-head]")).toHaveLength(1);
  });
});

describe("HoverCard", () => {
  it("carries the design tokens on the card itself, not on an ancestor", () => {
    // The card portals to document.body, outside .analysis. Custom properties
    // inherit down the tree, so the view's --an-* aliases (declared on
    // `.analysis-tokens` in analysis.css) resolve to nothing here unless the
    // card carries the class itself — and a rule reading an undefined property
    // is dropped without a word.
    render(
      <MantineProvider>
        <HoverCard sections={[section("ui.logs.hover-by-target", 1)]} {...DAMAGE_AMOUNT}>
          <button>row</button>
        </HoverCard>
      </MantineProvider>
    );
    fireEvent.mouseEnter(screen.getByText("row"));
    const card = document.querySelector('[data-testid="metric-hover-card"]');
    expect(card?.classList.contains("analysis-tokens")).toBe(true);
  });
});

describe("HoverCardBody — the detail flag", () => {
  const capped = (over: number) => [section("ui.logs.hover-by-ability", SECTION_ENTRY_CAP + over)];
  const renderDetailed = (sections: CardSection[]) =>
    render(
      <MantineProvider>
        <HoverCardBody sections={sections} {...DAMAGE_AMOUNT} detailed />
      </MantineProvider>
    );

  it("shows the capped tail when the flag is set", () => {
    renderDetailed(capped(2));
    expect(screen.getByText(`entry ${SECTION_ENTRY_CAP}`)).toBeTruthy();
    expect(screen.getByText(`entry ${SECTION_ENTRY_CAP + 1}`)).toBeTruthy();
  });

  it("leaves shares alone when the tail appears", () => {
    // Shares are already computed over the full total, so revealing the rest
    // of the list must not move a single figure — the tail was always counted.
    renderDetailed([section("ui.logs.hover-by-target", 6)]);
    expect(screen.getByText("28.6%")).toBeTruthy();
    expect(screen.queryByText("30.0%")).toBeNull();
  });

  it("leaves the bar scale alone when the tail appears", () => {
    // Entries are sorted descending, so the largest is always already shown —
    // setting the flag must not rescale the bars the reader was just looking at.
    const widthOfFirst = (container: HTMLElement) =>
      container.querySelectorAll<HTMLElement>("[data-testid='metric-bar-segment']")[0].style.width;

    const plain = renderBody(capped(1));
    const before = widthOfFirst(plain.container);
    plain.unmount();

    expect(widthOfFirst(renderDetailed(capped(1)).container)).toBe(before);
  });
});

describe("HoverCardBody — reserved row slots", () => {
  /** Rows drawn inside the FIRST section, placeholders included. */
  const rowsOfFirstSection = (container: HTMLElement) =>
    container.querySelector("[data-card-section]")!.querySelectorAll("[data-card-row]");

  it("holds a section at its reserved row count when fewer entries landed", () => {
    // The chart tooltip's section is one BUCKET of a plot: at any one second
    // most bands are zero and drop out, so an unreserved card resized under
    // the cursor on every move.
    const { container } = renderBody([{ ...section("ui.logs.hover-by-ability", 1), reserve: 4 }]);

    expect(rowsOfFirstSection(container)).toHaveLength(4);
    expect(screen.getByText("entry 0")).toBeTruthy();
  });

  it("adds nothing when the entries already fill the reserve", () => {
    const { container } = renderBody([{ ...section("ui.logs.hover-by-ability", 4), reserve: 4 }]);

    expect(rowsOfFirstSection(container)).toHaveLength(4);
  });

  it("still caps a section that overflows its reserve", () => {
    // The reserve sets a FLOOR on the rows drawn; the cap is still the ceiling.
    const { container } = renderBody([{ ...section("ui.logs.hover-by-ability", SECTION_ENTRY_CAP + 3), reserve: 2 }]);

    expect(rowsOfFirstSection(container)).toHaveLength(SECTION_ENTRY_CAP);
  });

  it("draws no placeholder in a section that was given no reserve", () => {
    // Every other card in the view has a fixed row set already — padding one
    // of those would open a gap under its last row for nothing.
    const { container } = renderBody([section("ui.logs.hover-by-ability", 1)]);

    expect(rowsOfFirstSection(container)).toHaveLength(1);
  });

  it("drops the reserve while the detail modifier is held", () => {
    // Detailed, the card is deliberately as long as its data; padding it to a
    // floor it has already passed would only add blank rows at the bottom.
    const { container } = render(
      <MantineProvider>
        <HoverCardBody
          sections={[{ ...section("ui.logs.hover-by-ability", 1), reserve: 4 }]}
          detailed
          {...DAMAGE_AMOUNT}
        />
      </MantineProvider>
    );

    expect(rowsOfFirstSection(container)).toHaveLength(1);
  });

  it("keeps a reserved section out of the empty-card check", () => {
    // `HoverCard` renders the row alone when every section is empty. A reserve
    // must not make an empty section look occupied and open a card of blanks.
    render(
      <MantineProvider>
        <HoverCard sections={[{ headingKey: "h", color: "red", entries: [], reserve: 4 }]} {...DAMAGE_AMOUNT}>
          <button>row</button>
        </HoverCard>
      </MantineProvider>
    );
    fireEvent.mouseEnter(screen.getByText("row"));

    expect(document.querySelector('[data-testid="metric-hover-card"]')).toBeNull();
  });
});

describe("HoverCard — the Ctrl detail modifier", () => {
  /** Ctrl down and up on the window, the way the browser delivers them. */
  const ctrl = (down: boolean) =>
    fireEvent(window, new KeyboardEvent(down ? "keydown" : "keyup", { key: "Control", ctrlKey: down }));

  /** The card open over its row, which is the only state it renders in. */
  const openCard = (over: number) => {
    render(
      <MantineProvider>
        <HoverCard sections={[section("ui.logs.hover-by-ability", SECTION_ENTRY_CAP + over)]} {...DAMAGE_AMOUNT}>
          <button>row</button>
        </HoverCard>
      </MantineProvider>
    );
    fireEvent.mouseEnter(screen.getByText("row"));
  };

  it("reveals the capped tail while Ctrl is held, and hides it again on release", () => {
    // The shell reads the key, not the body: `CursorCard` re-measures only when
    // its `content` prop changes identity, and a flag read inside the body
    // would grow the card while its cached size — and so its grow-up offset
    // and viewport clamps — stayed stale.
    openCard(2);
    expect(screen.queryByText(`entry ${SECTION_ENTRY_CAP}`)).toBeNull();

    ctrl(true);
    expect(screen.getByText(`entry ${SECTION_ENTRY_CAP}`)).toBeTruthy();
    expect(screen.getByText(`entry ${SECTION_ENTRY_CAP + 1}`)).toBeTruthy();

    ctrl(false);
    expect(screen.queryByText(`entry ${SECTION_ENTRY_CAP}`)).toBeNull();
  });

  it("hands the body a fresh element on the flip, so the shell re-measures", () => {
    // The regression this guards: `HoverCard` memoizes its body on the props
    // object. A flag that did not ride those props would leave the memo
    // holding the summary card for the whole hover.
    openCard(1);
    const card = document.querySelector('[data-testid="metric-hover-card"]');
    const before = card?.innerHTML;

    ctrl(true);
    expect(document.querySelector('[data-testid="metric-hover-card"]')?.innerHTML).not.toBe(before);
  });
});
