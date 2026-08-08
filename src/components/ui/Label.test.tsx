import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label } from "./Label";

// The suite has no jest-dom, so presence/attributes are read off the DOM node
// directly rather than through `toBeInTheDocument`/`toHaveAttribute`.

describe("Label", () => {
  it("renders its children", () => {
    render(<Label>Total Damage</Label>);
    expect(screen.getByText("Total Damage")).toBeTruthy();
  });

  it("carries the small-caps voice", () => {
    render(<Label>Uptime</Label>);
    const el = screen.getByText("Uptime");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("text-label");
    expect(el.className).toContain("text-ink-3");
  });

  it("appends caller classes rather than replacing its own", () => {
    render(<Label className="ml-auto">Uptime</Label>);
    const el = screen.getByText("Uptime");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("ml-auto");
  });

  it("renders as a section heading when asked", () => {
    render(<Label as="h3">Provenance</Label>);
    expect(screen.getByRole("heading", { name: "Provenance" })).toBeTruthy();
  });

  it("forwards aria-hidden, for captions whose group already carries the name", () => {
    render(<Label aria-hidden>Window</Label>);
    expect(screen.getByText("Window").getAttribute("aria-hidden")).toBe("true");
  });
});
