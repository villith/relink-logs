import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve());

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));

(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "logs" },
};

const { useSynthesisFormStore } = await import("./useSynthesisFormStore");

describe("durable stores", () => {
  // Proves the store writes through the adapter rather than straight to
  // localStorage: a save must reach the backend command too.
  it("persists a store write to the backend", () => {
    useSynthesisFormStore.getState().save({
      trait1: "abcd1234",
      trait2: null,
      anyOrder: false,
      requireLucky: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "synthesis-form" }));
  });
});
