import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: `vi.mock` factories run before the module body, so anything they
// close over has to be created by `vi.hoisted` rather than a plain top-level const.
const { setSize, LogicalSize, set, state } = vi.hoisted(() => {
  class LogicalSize {
    constructor(
      public width: number,
      public height: number
    ) {}
  }
  const set = vi.fn();
  return {
    setSize: vi.fn(),
    LogicalSize,
    set,
    state: { overlay_width: 500, overlay_height: 350, set },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  appWindow: { setSize: (...args: unknown[]) => setSize(...args) },
  LogicalSize,
}));

vi.mock("@/stores/useMeterSettingsStore", () => ({
  useMeterSettingsStore: (selector: (s: typeof state) => unknown) => selector(state),
  OVERLAY_MIN_SIZE: { width: 250, height: 120 },
}));

import { useOverlaySize } from "./useOverlaySize";

/** jsdom defines innerWidth/innerHeight as plain own properties, but assigning
 * through defineProperty keeps this working whatever jsdom decides they are. */
const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, writable: true, configurable: true });
};

/** Fire a resize and let the hook's 250ms debounce elapse. */
const resizeTo = async (width: number, height: number) => {
  setWindowSize(width, height);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(500);
  });
};

describe("useOverlaySize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSize.mockClear();
    set.mockClear();
    state.overlay_width = 500;
    state.overlay_height = 350;
    setWindowSize(500, 350);
    (window as unknown as Record<string, unknown>).__TAURI_IPC__ = () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_IPC__;
  });

  // Minimizing the overlay makes wry resize the webview to the minimized
  // window's client rect, which Windows reports as 0x0. That is not the user
  // choosing a new overlay size, and must not land in the settings.
  it("ignores the zero size a minimized window reports", async () => {
    renderHook(() => useOverlaySize());
    await resizeTo(0, 0);
    expect(set).not.toHaveBeenCalled();
  });

  // Same reasoning for any size the window itself would refuse: it cannot go
  // under its own minimum, so such a report is never a user resize.
  it("ignores a size below the window's minimum", async () => {
    renderHook(() => useOverlaySize());
    await resizeTo(200, 100);
    expect(set).not.toHaveBeenCalled();
  });

  it("records a real user resize", async () => {
    renderHook(() => useOverlaySize());
    await resizeTo(700, 420);
    expect(set).toHaveBeenCalledWith({ overlay_width: 700, overlay_height: 420 });
  });

  // A settings value persisted by the old bug (the app closed while the overlay
  // was minimized) must not be applied to the window as-is.
  it("clamps a stored size below the minimum before applying it", async () => {
    state.overlay_width = 0;
    state.overlay_height = 0;
    renderHook(() => useOverlaySize());
    expect(setSize).toHaveBeenCalledWith(new LogicalSize(250, 120));
  });

  it("applies a stored size to the window", async () => {
    state.overlay_width = 640;
    state.overlay_height = 400;
    renderHook(() => useOverlaySize());
    expect(setSize).toHaveBeenCalledWith(new LogicalSize(640, 400));
  });
});
