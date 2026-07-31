import type { HeaderSegment } from "@/stores/useMeterSettingsStore";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeaderSegments } from "./HeaderSegments";

const segments: HeaderSegment[] = [
  { id: "brand", side: "left", template: "{app} {version}", hideWhenNarrow: false },
  { id: "dmg", side: "left", template: "{damage}", hideWhenNarrow: true },
  { id: "status", side: "right", template: "{status}", hideWhenNarrow: false },
];

// `damage` empty models a fight before the first hit lands.
const tokens = { app: "Relink Logs", version: "1.0.0", damage: "", status: "02:41" };

describe("HeaderSegments", () => {
  it("renders only the segments for the requested side", () => {
    render(<HeaderSegments segments={segments} side="left" tokens={tokens} toneClass="" />);
    expect(screen.getByText("Relink Logs 1.0.0")).toBeTruthy();
    expect(screen.queryByText("02:41")).toBeNull();
  });

  it("omits a segment whose tokens all resolve empty", () => {
    const { container } = render(<HeaderSegments segments={segments} side="left" tokens={tokens} toneClass="" />);
    // The brand renders; the damage segment has nothing to say yet, so it is
    // not rendered at all — no stranded separator.
    expect(container.querySelectorAll(".item")).toHaveLength(1);
  });

  it("renders a segment once its tokens have values", () => {
    const withDamage = { ...tokens, damage: "1.2b" };
    const { container } = render(<HeaderSegments segments={segments} side="left" tokens={withDamage} toneClass="" />);
    expect(container.querySelectorAll(".item")).toHaveLength(2);
    expect(screen.getByText("1.2b")).toBeTruthy();
  });

  it("marks a narrow-hidden segment so CSS can drop it", () => {
    const withDamage = { ...tokens, damage: "1.2b" };
    const { container } = render(<HeaderSegments segments={segments} side="left" tokens={withDamage} toneClass="" />);
    expect(container.querySelectorAll(".hide-narrow")).toHaveLength(1);
  });

  it("keeps the status class and tone so the connection dot still draws", () => {
    const { container } = render(
      <HeaderSegments segments={segments} side="right" tokens={tokens} toneClass="hook-ok" />
    );
    const item = container.querySelector(".item");
    expect(item?.className).toContain("encounter-status");
    expect(item?.className).toContain("hook-ok");
  });

  it("does not put the tone class on a non-status segment", () => {
    const { container } = render(
      <HeaderSegments segments={segments} side="left" tokens={tokens} toneClass="hook-ok" />
    );
    expect(container.querySelector(".item")?.className).not.toContain("hook-ok");
  });

  it("keeps every rendered segment draggable", () => {
    const { container } = render(<HeaderSegments segments={segments} side="left" tokens={tokens} toneClass="" />);
    // Tauri only starts a drag from the element that carries the attribute.
    expect(container.querySelector(".item")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });
});
