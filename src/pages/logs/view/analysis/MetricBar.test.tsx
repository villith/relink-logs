import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricBar } from "./MetricBar";

/** The suite has no jest-dom, so widths are read off the inline style rather
 * than through `toHaveStyle` — the same assertion, one dependency lighter. */
const segments = () => screen.getAllByTestId("metric-bar-segment") as HTMLElement[];

const renderBar = (props: React.ComponentProps<typeof MetricBar>) =>
  render(
    <MantineProvider>
      <MetricBar {...props} />
    </MantineProvider>
  );

describe("MetricBar", () => {
  it("draws one segment when nothing is supplementary", () => {
    renderBar({ value: 50, largest: 100, color: "red", variant: "row" });
    expect(segments()).toHaveLength(1);
    expect(segments()[0].style.width).toBe("50%");
  });

  it("splits into a direct and a supplementary segment", () => {
    renderBar({ value: 50, subValue: 20, largest: 100, color: "red", variant: "row" });
    expect(segments()).toHaveLength(2);
    // Direct part first: (50 - 20) / 100.
    expect(segments()[0].style.width).toBe("30%");
    expect(segments()[0].style.left).toBe("0%");
    // Supplementary picks up exactly where it ends and reaches value/largest.
    expect(segments()[1].style.width).toBe("20%");
    expect(segments()[1].style.left).toBe("30%");
  });

  const track = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-bar-track]");

  it("bites a notch out of the segment standing at the fill's left edge", () => {
    const { container } = renderBar({
      value: 50,
      subValue: 20,
      largest: 100,
      color: "red",
      variant: "row",
      head: "notch",
    });
    // The direct part is what the diamond meets; the supplementary one picks up
    // further along the bar and keeps a square edge.
    expect(segments()[0].style.clipPath).toContain("polygon");
    expect(segments()[1].style.clipPath).toBe("");
    // And the whole fill starts at the art's centre, so the notch's own point
    // lands on the art's right corner.
    expect(track(container)?.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]");
    expect(track(container)?.className).not.toContain("inset-x-0");
  });

  it("heads the bar at the art's left edge where nothing nests into it", () => {
    // A bust is not a diamond: the bar draws the head ITSELF and the art stands
    // on it, so the fill has to reach back to where the art starts.
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "row", head: "point" });
    expect(segments()[0].style.clipPath).toContain("polygon");
    expect(track(container)?.className).toContain("left-[var(--row-pad)]");
  });

  it("heads the supplementary segment when a row is supplementary in full", () => {
    // Direct is zero here, so the supplementary segment IS the fill's left end.
    // Heading the empty one would leave the visible bar square-edged and the
    // diamond nesting into nothing.
    renderBar({ value: 50, subValue: 50, largest: 100, color: "red", variant: "row", head: "notch" });
    expect(segments()[1].style.clipPath).toContain("polygon");
  });

  it("keeps a square edge and a full-bleed track when nothing stands at it", () => {
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "row" });
    expect(segments()[0].style.clipPath).toBe("");
    expect(track(container)?.className).toContain("inset-x-0");
  });

  it("draws the hover ring in the bar's own silhouette, not as a rectangle", () => {
    // The row stands its own rectangular outline down for this (see
    // `AnalysisRow`), so without the ring a headed bar has no hover state at
    // all — and with a rectangle it would state a shape the bar does not have.
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "row", head: "notch" });
    const ring = container.querySelector<HTMLElement>("[data-bar-ring]");
    expect(ring).toBeTruthy();
    // Outer boundary then the same shape inset a pixel, wound the other way —
    // the hole that leaves is the stroke.
    expect(ring!.style.clipPath).toContain("1.415px");
    expect(ring!.className).toContain("group-hover:opacity-100");
    // The ring reads the SAME left offset as the fill, or it would frame a bar
    // standing somewhere else.
    expect(ring!.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]");
  });

  it("draws no ring on a card entry, which is not a hover target of its own", () => {
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "card", head: "point" });
    expect(container.querySelector("[data-bar-ring]")).toBeNull();
    // A card row measures its head against the CARD's art, which is its own
    // row height — not the table's.
    expect(track(container)?.className).toContain("left-[var(--row-pad)]");
    expect(segments()[0].style.clipPath).toContain("--spacing-art-card");
  });

  it("renders at zero width rather than NaN when every peer is zero", () => {
    renderBar({ value: 0, largest: 0, color: "red", variant: "row" });
    expect((screen.getByTestId("metric-bar-segment") as HTMLElement).style.width).toBe("0%");
  });
});
