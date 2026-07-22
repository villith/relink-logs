import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/os", () => ({ platform: vi.fn().mockResolvedValue("linux") }));

import { useIsLinux } from "./platform";

describe("useIsLinux", () => {
  it("flips to true once the platform resolves to linux", async () => {
    const { result } = renderHook(() => useIsLinux());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("getPlatform caches: two hook mounts trigger one platform() call", async () => {
    const { platform } = await import("@tauri-apps/api/os");
    const first = renderHook(() => useIsLinux());
    await waitFor(() => expect(first.result.current).toBe(true));
    const second = renderHook(() => useIsLinux());
    await waitFor(() => expect(second.result.current).toBe(true));
    expect(vi.mocked(platform)).toHaveBeenCalledTimes(1);
  });
});
