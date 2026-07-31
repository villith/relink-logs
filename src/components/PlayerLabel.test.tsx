import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlayerLabel } from "./PlayerLabel";

const tokens = { slot: "1", name: "Scott", character: "Narmaya", icon: "Pl1400" };

describe("PlayerLabel", () => {
  it("renders the template as text when it uses no icon", () => {
    const { container } = render(<PlayerLabel template="[{slot}] {name} ({character})" tokens={tokens} />);
    expect(container.textContent).toBe("[1] Scott (Narmaya)");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an icon token as an image and keeps the surrounding text", () => {
    const { container } = render(<PlayerLabel template="{icon} {name}" tokens={tokens} />);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/Pl1400\.png/);
    expect(container.textContent).toBe(" Scott");
  });

  /**
   * The icon carries no information the label does not already state, so it is
   * decorative: naming it would make a screen reader announce the character
   * twice for the common `{icon} {name} ({character})` template.
   */
  it("marks the icon decorative", () => {
    const { container } = render(<PlayerLabel template="{icon} {name}" tokens={tokens} />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  /**
   * A character with no art must collapse like any other empty token — the
   * bracket group has to go rather than render as an empty pair.
   */
  it("collapses the template when the character has no icon", () => {
    const { container } = render(<PlayerLabel template="{icon} ({name})" tokens={{ ...tokens, icon: "Pl9999" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Scott");
  });

  it("renders nothing when every token is empty", () => {
    const { container } = render(<PlayerLabel template="{icon} {name}" tokens={{ icon: "", name: "" }} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("img")).toBeNull();
  });
});
