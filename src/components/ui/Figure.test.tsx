import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Figure } from "./Figure";

// The suite has no jest-dom, so presence is read off the DOM node directly
// rather than through `toBeInTheDocument`.

describe("Figure", () => {
  it("renders its children", () => {
    render(<Figure>1,234,567</Figure>);
    expect(screen.getByText("1,234,567")).toBeTruthy();
  });

  it("is always tabular, so columns align down the page", () => {
    render(<Figure>123</Figure>);
    expect(screen.getByText("123").className).toContain("tabular-nums");
  });

  it("defaults to row size and full-strength ink", () => {
    render(<Figure>123</Figure>);
    const cls = screen.getByText("123").className;
    expect(cls).toContain("text-lg");
    expect(cls).not.toContain("text-ink-2");
  });

  it("takes a size and a muted tone", () => {
    render(
      <Figure size="sm" tone="muted">
        99%
      </Figure>
    );
    const cls = screen.getByText("99%").className;
    expect(cls).toContain("text-sm");
    expect(cls).toContain("text-ink-2");
  });

  it("takes the headline size", () => {
    render(<Figure size="2xl">42M</Figure>);
    expect(screen.getByText("42M").className).toContain("text-2xl");
  });

  it("appends caller classes", () => {
    render(<Figure className="w-cell text-right">7</Figure>);
    const cls = screen.getByText("7").className;
    expect(cls).toContain("w-cell");
    expect(cls).toContain("tabular-nums");
  });
});
