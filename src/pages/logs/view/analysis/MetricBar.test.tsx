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
  const headOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-bar-head]");

  it("draws a notched head as its own fixed piece and starts the fill at the art's right edge", () => {
    const { container } = renderBar({
      value: 50,
      subValue: 20,
      largest: 100,
      color: "red",
      variant: "row",
      head: "notch",
    });
    // The head stands at the art's centre — the diamond's own right half fills
    // its bite — and is exactly half an art wide, ending where the box does.
    const head = headOf(container);
    expect(head).toBeTruthy();
    expect(head!.style.clipPath).toContain("polygon");
    expect(head!.style.backgroundColor).toBe("red");
    expect(head!.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]");
    // The fill's zero is the art box's right edge: the head is identity, drawn
    // in full whatever the value, and the fill alone states the magnitude. The
    // 1px rides back under the head so the seam cannot open (see TRACK_LEFT).
    expect(track(container)?.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)_-_1px)]");
    expect(track(container)?.className).not.toContain("inset-x-0");
    // The segments are plain rectangles now — no head rides the fill.
    expect(segments()[0].style.clipPath).toBe("");
    expect(segments()[1].style.clipPath).toBe("");
  });

  it("covers the art's whole box with the head where nothing nests into it", () => {
    // A bust is not a diamond: the head reaches back to the art's left edge so
    // the bust stands on the row's own colour, and the fill still starts at
    // the box's right edge like every other bar's.
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "row", head: "point" });
    const head = headOf(container);
    expect(head!.className).toContain("left-[var(--row-pad)]");
    expect(head!.className).toContain("w-[var(--spacing-art)]");
    expect(track(container)?.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)_-_1px)]");
  });

  it("draws the head even at zero value — identity, not magnitude", () => {
    // The icon's area wears the row's colour whatever the number says; only
    // the fill is proportional, and at zero there is simply none of it.
    const { container } = renderBar({ value: 0, largest: 100, color: "red", variant: "row", head: "notch" });
    expect(headOf(container)).toBeTruthy();
    expect(segments()[0].style.width).toBe("0%");
  });

  it("keeps a square edge and a full-bleed track when nothing stands at it", () => {
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "row" });
    expect(segments()[0].style.clipPath).toBe("");
    expect(track(container)?.className).toContain("inset-x-0");
    expect(headOf(container)).toBeNull();
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
    // The ring starts where the SILHOUETTE does — the head's own left edge —
    // or it would frame a bar standing somewhere else.
    expect(ring!.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]");
  });

  it("draws no ring on a card entry, which is not a hover target of its own", () => {
    const { container } = renderBar({ value: 50, largest: 100, color: "red", variant: "card", head: "point" });
    expect(container.querySelector("[data-bar-ring]")).toBeNull();
    // A card row measures its head against the CARD's art, which is its own
    // row height — not the table's.
    expect(headOf(container)?.className).toContain("w-[var(--spacing-art-card)]");
    expect(track(container)?.className).toContain("left-[calc(var(--row-pad)_+_var(--spacing-art-card)_-_1px)]");
  });

  it("renders at zero width rather than NaN when every peer is zero", () => {
    renderBar({ value: 0, largest: 0, color: "red", variant: "row" });
    expect((screen.getByTestId("metric-bar-segment") as HTMLElement).style.width).toBe("0%");
  });
});
