import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoverCard, HoverCardBody, type CardSection } from "./HoverCard";

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

const renderBody = (sections: CardSection[]) =>
  render(
    <MantineProvider>
      <HoverCardBody sections={sections} />
    </MantineProvider>
  );

describe("HoverCardBody", () => {
  it("renders a heading per section", () => {
    renderBody([section("ui.logs.hover-by-ability", 2), section("ui.logs.hover-by-target", 1)]);
    expect(screen.getByText("ui.logs.hover-by-ability")).toBeTruthy();
    expect(screen.getByText("ui.logs.hover-by-target")).toBeTruthy();
  });

  it("renders every entry — long lists are never truncated", () => {
    renderBody([section("ui.logs.hover-by-ability", 24)]);
    expect(screen.getByText("entry 0")).toBeTruthy();
    expect(screen.getByText("entry 23")).toBeTruthy();
  });

  it("scales bars against the section's largest entry", () => {
    // Scaling to the section total would draw a three-row target list as three
    // slivers.
    const { container } = renderBody([section("ui.logs.hover-by-target", 4)]);
    const bars = container.querySelectorAll<HTMLElement>("[data-card-bar]");
    expect(bars[0].style.width).toBe("100%");
    expect(bars[3].style.width).toBe("25%");
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

    const head = container.querySelector(".analysis-card-head")!.textContent;
    expect(head!.indexOf("ui.meter-columns.damage")).toBeLessThan(head!.indexOf("ui.logs.column-share"));

    const row = container.querySelector(".analysis-card-row")!;
    const cells = [...row.querySelectorAll(".analysis-card-amount, .analysis-card-share")].map((c) => c.className);
    expect(cells[0]).toContain("analysis-card-amount");
    expect(cells[1]).toContain("analysis-card-share");
  });

  it("skips a section with no entries rather than drawing an empty heading", () => {
    renderBody([section("ui.logs.hover-by-ability", 0), section("ui.logs.hover-by-target", 1)]);
    expect(screen.queryByText("ui.logs.hover-by-ability")).toBeNull();
    expect(screen.getByText("ui.logs.hover-by-target")).toBeTruthy();
  });
});

describe("HoverCard", () => {
  it("carries the design tokens on the card itself, not on an ancestor", () => {
    // The card portals to document.body, outside .analysis. Custom properties
    // inherit down the tree, so tokens declared only on .analysis resolve to
    // nothing here and the card's own var(--an-panel) background and
    // var(--an-line-strong) border render as no panel at all.
    render(
      <MantineProvider>
        <HoverCard sections={[section("ui.logs.hover-by-target", 1)]}>
          <button>row</button>
        </HoverCard>
      </MantineProvider>
    );
    fireEvent.mouseEnter(screen.getByText("row"));
    const card = document.querySelector('[data-testid="metric-hover-card"]');
    expect(card?.classList.contains("analysis-tokens")).toBe(true);
  });
});

