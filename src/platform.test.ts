import { renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/os", () => ({ platform: vi.fn().mockResolvedValue("linux") }));

import { useIsLinux } from "./platform";

describe("useIsLinux", () => {
  it("flips to true once the platform resolves to linux", async () => {
    const { result } = renderHook(() => useIsLinux());
    await waitFor(() => expect(result.current).toBe(true));
  });
});
