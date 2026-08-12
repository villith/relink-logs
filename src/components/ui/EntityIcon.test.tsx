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

  // Exact class tokens, never `className.toContain`: "size-icon" is a substring
  // of both "size-icon-sm" and "size-icon-xs", so a substring check would pass
  // on the very mix-up these three assertions exist to catch.
  const classesOf = (el: Element) => el.className.split(" ");

  it("defaults to the row size", () => {
    render(<EntityIcon src="/art/io.png" alt="Io" />);
    expect(classesOf(screen.getByAltText("Io"))).toContain("size-icon");
  });

  it("takes the bar size, which is the height of the bar it nests into", () => {
    render(<EntityIcon src="/a.png" alt="a" size="bar" />);
    expect(classesOf(screen.getByAltText("a"))).toContain("size-art");
    expect(classesOf(screen.getByAltText("a"))).not.toContain("size-icon");
  });

  it("takes the control and card sizes", () => {
    const { rerender } = render(<EntityIcon src="/a.png" alt="a" size="control" />);
    expect(classesOf(screen.getByAltText("a"))).toContain("size-icon-sm");
    expect(classesOf(screen.getByAltText("a"))).not.toContain("size-icon");

    rerender(<EntityIcon src="/a.png" alt="a" size="card" />);
    expect(classesOf(screen.getByAltText("a"))).toContain("size-icon-xs");
    expect(classesOf(screen.getByAltText("a"))).not.toContain("size-icon");
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
