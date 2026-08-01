import { beforeEach, describe, expect, it, vi } from "vitest";

// Cross-window settings sync goes through settings.db: a write reaches the
// backend, which emits `settings-changed` to every window. This replaced a
// value-carrying `emit` broadcast, which existed because on Linux (WebKitGTK)
// webviews neither share localStorage nor fire cross-window `storage` events
// (tauri-apps/tauri#10981).

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve());
const emitMock = vi.fn<[string, unknown], Promise<void>>(() => Promise.resolve());
type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => emitMock(event, payload),
  listen: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
    return Promise.resolve(() => {});
  },
}));

(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "logs" },
};

const { useMeterSettingsStore } = await import("./useMeterSettingsStore");
const { SETTINGS_CHANGED_EVENT } = await import("./durableStorage");

describe("meter settings cross-window sync", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    emitMock.mockClear();
  });

  it("persists a change through the backend instead of broadcasting values", () => {
    useMeterSettingsStore.getState().set({ transparency: 0.55 });

    expect(useMeterSettingsStore.getState().transparency).toBe(0.55);
    expect(invokeMock).toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "meter-settings" }));
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("adopts a change made in the other window", () => {
    const payload = JSON.stringify({
      state: { ...useMeterSettingsStore.getState(), transparency: 0.9 },
      version: 2,
    });

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "meter-settings", value: payload, origin: "main" },
    });

    expect(useMeterSettingsStore.getState().transparency).toBe(0.9);
  });
});
