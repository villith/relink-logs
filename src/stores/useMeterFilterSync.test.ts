import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<[command: string, args?: unknown], Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: Parameters<typeof invoke>) => invoke(...a) }));

import { useMeterSettingsStore } from "./useMeterSettingsStore";

import { useMeterFilterSync } from "./useMeterFilterSync";

describe("useMeterFilterSync", () => {
  beforeEach(() => {
    invoke.mockClear();
    useMeterSettingsStore.setState({ include_primal_burst: false });
  });

  it("pushes the current filters on mount", () => {
    // The backend copy is in-memory only, so a restart would otherwise leave it
    // on the default while the persisted store said otherwise.
    renderHook(() => useMeterFilterSync());

    expect(invoke).toHaveBeenCalledWith("set_meter_filters", {
      filters: { includePrimalBurst: false },
    });
  });

  it("pushes again when the setting changes", () => {
    const { rerender } = renderHook(() => useMeterFilterSync());
    invoke.mockClear();

    act(() => useMeterSettingsStore.setState({ include_primal_burst: true }));
    rerender();

    expect(invoke).toHaveBeenCalledWith("set_meter_filters", {
      filters: { includePrimalBurst: true },
    });
  });

  it("does not push when an unrelated setting changes", () => {
    // Every push makes the live parser replay its event log, so a transparency
    // drag must not reach it.
    const { rerender } = renderHook(() => useMeterFilterSync());
    invoke.mockClear();

    act(() => useMeterSettingsStore.setState({ transparency: 0.7 }));
    rerender();

    expect(invoke).not.toHaveBeenCalled();
  });
});
