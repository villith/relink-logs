import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners: Record<string, (e: { payload: unknown }) => void> = {};
const listen = vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
  listeners[event] = cb;
  return Promise.resolve(() => delete listeners[event]);
});

vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: Parameters<typeof listen>) => listen(...a) }));

import { useHookStatus } from "./useHookStatus";

describe("useHookStatus", () => {
  beforeEach(() => {
    invoke.mockReset();
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it("seeds from get_hook_status on mount", async () => {
    invoke.mockResolvedValue({
      state: "connected",
      hookVersion: "1.0.0",
      appVersion: "1.0.0",
      supportsEject: true,
    });
    const { result } = renderHook(() => useHookStatus());
    await waitFor(() => expect(result.current?.state).toBe("connected"));
    expect(invoke).toHaveBeenCalledWith("get_hook_status");
  });

  it("updates when a hook-status event arrives", async () => {
    invoke.mockResolvedValue({
      state: "disconnected",
      hookVersion: null,
      appVersion: "1.0.0",
      supportsEject: false,
    });
    const { result } = renderHook(() => useHookStatus());
    await waitFor(() => expect(result.current?.state).toBe("disconnected"));
    act(() => {
      listeners["hook-status"]({
        payload: { state: "outOfDate", hookVersion: "0.9.0", appVersion: "1.0.0", supportsEject: true },
      });
    });
    await waitFor(() => expect(result.current?.state).toBe("outOfDate"));
  });
});
