import { render, screen } from "@testing-library/react";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { PaneLoading } from "./PaneLoading";

const overlay = () => screen.queryByRole("status");

/** Past the appear delay. */
const settle = (ms = 200) => act(() => void vi.advanceTimersByTime(ms));

describe("PaneLoading", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws nothing while nothing is pending", () => {
    render(<PaneLoading pending={false} />);
    settle();
    expect(overlay()).toBeNull();
  });

  // A scoped fetch over a log already in memory usually lands inside the delay,
  // and an overlay that appeared and vanished in two frames would BE the flicker
  // this exists to remove.
  it("holds off until a fetch has actually taken a moment", () => {
    const { rerender } = render(<PaneLoading pending />);
    expect(overlay()).toBeNull();

    act(() => void vi.advanceTimersByTime(100));
    expect(overlay()).toBeNull();

    // Answered inside the delay: nothing was ever drawn.
    rerender(<PaneLoading pending={false} />);
    settle();
    expect(overlay()).toBeNull();
  });

  it("covers the pane once the wait is real", () => {
    render(<PaneLoading pending />);
    settle();
    expect(overlay()).not.toBeNull();
  });

  // Immediate on the way out: holding the cover past the answer would add a
  // second wait of our own on top of the one that just ended.
  it("uncovers the moment the answer lands", () => {
    const { rerender } = render(<PaneLoading pending />);
    settle();
    expect(overlay()).not.toBeNull();

    rerender(<PaneLoading pending={false} />);
    expect(overlay()).toBeNull();
  });
});
