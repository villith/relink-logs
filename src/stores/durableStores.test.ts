import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve());
type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
    return Promise.resolve(() => {});
  },
}));

(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "logs" },
};

const { SETTINGS_CHANGED_EVENT } = await import("./durableStorage");
const { useSynthesisFormStore } = await import("./useSynthesisFormStore");

describe("durable stores", () => {
  // Proves the store writes through the adapter rather than straight to
  // localStorage: a save must reach the backend command too.
  it("persists a store write to the backend", () => {
    invokeMock.mockClear();

    useSynthesisFormStore.getState().save({
      trait1: "abcd1234",
      trait2: null,
      anyOrder: false,
      requireLucky: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "synthesis-form" }));
  });

  /* The regression that locked the app up. zustand's `persist.rehydrate()`
     finishes by writing the hydrated state back through the same storage
     adapter, and for a synchronous adapter it does so synchronously. So
     applying a change from the other window *is* a storage write: if it
     reaches `set_setting`, the backend broadcasts it, the other window
     rehydrates, writes, broadcasts back — an unbounded ping-pong that
     saturated the IPC and rewrote settings.db as fast as both windows could
     manage. It needs no user action to start; hydrating at boot is enough. */
  it("does not echo a remote change back to the backend", () => {
    invokeMock.mockClear();

    const envelope = JSON.stringify({
      state: { saved: { trait1: "beef0001", trait2: null, anyOrder: true, requireLucky: false } },
      version: 1,
    });

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "synthesis-form", value: envelope, origin: "main" },
    });

    // The change still lands: suppressing the echo must not cost the update.
    expect(useSynthesisFormStore.getState().saved?.trait1).toBe("beef0001");
    expect(localStorage.getItem("synthesis-form")).toBe(envelope);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // A local change after applying a remote one must still persist — proof the
  // suppression is scoped to the apply and not left switched on.
  it("still persists a local write made after a remote change", () => {
    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "synthesis-form", value: JSON.stringify({ state: { saved: null }, version: 1 }), origin: "main" },
    });
    invokeMock.mockClear();

    useSynthesisFormStore.getState().save({
      trait1: "cafe0002",
      trait2: null,
      anyOrder: false,
      requireLucky: false,
    });

    expect(invokeMock).toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "synthesis-form" }));
  });
});
