import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CursorCard } from "./CursorCard";

const withMantine = (node: ReactNode) => render(<MantineProvider>{node}</MantineProvider>);

const renderIt = (childProps: Record<string, unknown> = {}) =>
  withMantine(
    <CursorCard content={<div>breakdown</div>} testId="cursor-card">
      <button {...childProps}>row</button>
    </CursorCard>
  );

describe("CursorCard", () => {
  it("mounts the panel only while hovered", () => {
    // Mounting it always is what janked the quest view: one of these per row,
    // each holding a large subtree that repositions on every mousemove.
    renderIt();
    expect(screen.queryByTestId("cursor-card")).toBeNull();

    fireEvent.mouseEnter(screen.getByText("row"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("cursor-card")).toBeTruthy();

    fireEvent.mouseLeave(screen.getByText("row"));
    expect(screen.queryByTestId("cursor-card")).toBeNull();
  });

  it("keeps the child's own mouse handlers", () => {
    // The shell clones the child to attach its own; dropping the child's would
    // silently break row hover-highlighting wherever a card is used.
    const onMouseEnter = vi.fn();
    const onMouseMove = vi.fn();
    const onMouseLeave = vi.fn();
    renderIt({ onMouseEnter, onMouseMove, onMouseLeave });

    const row = screen.getByText("row");
    fireEvent.mouseEnter(row, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(row, { clientX: 20, clientY: 20 });
    fireEvent.mouseLeave(row);

    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
  });

  it("dismisses on scroll and on wheel", () => {
    // A position: fixed panel would otherwise sit frozen over a now-different
    // row when the table scrolls under a still mouse.
    renderIt();
    fireEvent.mouseEnter(screen.getByText("row"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("cursor-card")).toBeTruthy();

    fireEvent.scroll(window);
    expect(screen.queryByTestId("cursor-card")).toBeNull();

    fireEvent.mouseEnter(screen.getByText("row"), { clientX: 100, clientY: 100 });
    fireEvent.wheel(window);
    expect(screen.queryByTestId("cursor-card")).toBeNull();
  });

  it("owns positioning, and the caller's style cannot override it", () => {
    // Chrome is the caller's; position/stacking/visibility are not, or a card
    // could place itself out of the viewport clamp.
    withMantine(
      <CursorCard
        content={<div>breakdown</div>}
        testId="cursor-card"
        style={{ position: "static", zIndex: 1, backgroundColor: "rgb(1, 2, 3)" }}
      >
        <button>row</button>
      </CursorCard>
    );
    fireEvent.mouseEnter(screen.getByText("row"), { clientX: 100, clientY: 100 });

    const card = screen.getByTestId("cursor-card");
    expect(card.style.position).toBe("fixed");
    expect(card.style.zIndex).toBe("300");
    expect(card.style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("stays hidden until it has been measured", () => {
    // jsdom reports a zero-size box, which is the same state as the first real
    // frame — the panel must not paint before the grow-up offset is known, or
    // it flashes at the wrong spot.
    renderIt();
    fireEvent.mouseEnter(screen.getByText("row"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("cursor-card").style.visibility).toBe("hidden");
  });
});
