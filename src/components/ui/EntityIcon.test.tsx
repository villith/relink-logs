import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntityIcon } from "./EntityIcon";

// The suite has no jest-dom, so presence/attributes are read off the DOM node
// directly rather than through `toBeInTheDocument`/`toHaveAttribute`.

describe("EntityIcon", () => {
  it("renders the source with its alt text", () => {
    render(<EntityIcon src="/art/io.png" alt="Io" />);
    expect(screen.getByAltText("Io").getAttribute("src")).toBe("/art/io.png");
  });

  it("defaults to the row size", () => {
    render(<EntityIcon src="/art/io.png" alt="Io" />);
    expect(screen.getByAltText("Io").className).toContain("size-icon");
  });

  it("takes the control and card sizes", () => {
    const { rerender } = render(<EntityIcon src="/a.png" alt="a" size="control" />);
    expect(screen.getByAltText("a").className).toContain("size-icon-sm");

    rerender(<EntityIcon src="/a.png" alt="a" size="card" />);
    expect(screen.getByAltText("a").className).toContain("size-icon-xs");
  });

  it("contains rather than crops, so mixed aspect ratios line up", () => {
    render(<EntityIcon src="/art/io.png" alt="Io" />);
    expect(screen.getByAltText("Io").className).toContain("object-contain");
  });

  it("marks itself decorative when it has no alt text", () => {
    const { container } = render(<EntityIcon src="/art/io.png" alt="" />);
    expect(container.querySelector("img")?.getAttribute("aria-hidden")).toBe("true");
  });
});
