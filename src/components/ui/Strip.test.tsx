import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Strip } from "./Strip";

// The suite has no jest-dom, so presence is read off the DOM node directly
// rather than through `toBeInTheDocument`.

describe("Strip", () => {
  it("renders its children", () => {
    render(<Strip>content</Strip>);
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("draws a bottom rule by default", () => {
    const { container } = render(<Strip>x</Strip>);
    expect(container.firstElementChild?.className).toContain("border-b");
    expect(container.firstElementChild?.className).toContain("border-line");
  });

  it("draws a top rule instead when asked", () => {
    const { container } = render(<Strip rule="top">x</Strip>);
    expect(container.firstElementChild?.className).toContain("border-t");
    expect(container.firstElementChild?.className).not.toContain("border-b");
  });

  it("draws no rule when asked", () => {
    const { container } = render(<Strip rule="none">x</Strip>);
    const cls = container.firstElementChild?.className ?? "";
    expect(cls).not.toContain("border-b");
    expect(cls).not.toContain("border-t");
  });

  it("wraps only when asked, so a toolbar row stays one line", () => {
    const { container, rerender } = render(<Strip>x</Strip>);
    expect(container.firstElementChild?.className).not.toContain("flex-wrap");

    rerender(<Strip wrap>x</Strip>);
    expect(container.firstElementChild?.className).toContain("flex-wrap");
  });

  it("aligns to the baseline when asked, for a row of mixed type sizes", () => {
    const { container } = render(<Strip align="baseline">x</Strip>);
    expect(container.firstElementChild?.className).toContain("items-baseline");
  });

  it("appends caller classes", () => {
    const { container } = render(<Strip className="px-6">x</Strip>);
    expect(container.firstElementChild?.className).toContain("px-6");
  });
});
