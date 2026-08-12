import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RowArt } from "./RowArt";

// The suite has no jest-dom, so attributes are read off the DOM node directly.

describe("RowArt", () => {
  it("draws the art at the height of the bar it nests into", () => {
    const { container } = render(<RowArt src="/art/zerreissen.png" />);
    const art = container.querySelector<HTMLImageElement>("img");
    expect(art?.getAttribute("src")).toBe("/art/zerreissen.png");
    expect(art!.className.split(" ")).toContain("size-art");
  });

  it("takes the card's own height where it stands at a card's bar", () => {
    const { container } = render(<RowArt src="/art/zerreissen.png" scale="card" />);
    expect(container.querySelector("img")!.className.split(" ")).toContain("size-art-card");
  });

  it("stands every piece of art on a diamond ground", () => {
    // Only the ability art IS a diamond. A bust, a boss portrait and a status
    // mark are cut-outs that would otherwise float on whatever colour the row
    // happens to be — and the ability art covers this shape exactly, so drawing
    // it always costs the diamonds nothing and cannot be forgotten for a new
    // kind of art.
    for (const shape of ["diamond", "actor"] as const) {
      const { container } = render(<RowArt src="/art/a.png" shape={shape} />);
      const ground = container.querySelector<HTMLElement>("[data-row-art-ground]");
      expect(ground?.style.clipPath).toContain("polygon");
      expect(ground?.style.backgroundColor).toBe("rgba(0, 0, 0, 0.35)");
    }
  });

  it("contains the art rather than cropping it to the diamond", () => {
    // A bust is wider at the shoulders than a diamond is at its base.
    const { container } = render(<RowArt src="/art/gran.png" shape="actor" />);
    const art = container.querySelector<HTMLImageElement>("img");
    expect(art!.className).toContain("object-contain");
    expect(art!.style.clipPath).toBe("");
  });

  it("keeps the box empty behind an actor, so the bar shows through it", () => {
    // A bust has no diamond for the bar to nest into and the bar runs
    // full-bleed behind it — a placeholder diamond here would be a shape
    // standing in front of a bar that is already whole.
    const { container } = render(<RowArt shape="actor" />);
    const box = container.querySelector<HTMLElement>("[data-row-art-empty]");
    expect(box?.style.clipPath).toBe("");
    expect(box?.style.backgroundColor).toBe("");
  });

  it("keeps the box for a row the game draws no picture for", () => {
    // Two things ride on it: the name column's left edge stays put down the
    // whole table, and the bite the bar has taken out of itself is filled
    // rather than left standing as a notch cut for nothing.
    const { container } = render(<RowArt />);
    expect(container.querySelector("img")).toBeNull();
    const box = container.querySelector<HTMLElement>("[data-row-art-empty]");
    expect(box).toBeTruthy();
    expect(box!.className.split(" ")).toContain("size-art");
    expect(box!.style.clipPath).toContain("polygon");
  });
});
