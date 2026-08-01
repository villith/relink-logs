import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve());
type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
    return Promise.resolve(() => {});
  },
}));

// The module only wires up the remote listener inside a real Tauri window, and
// reads its own label from the metadata Tauri injects. Fake both before the
// module-scope registration runs.
(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "logs" },
};

const { durableStorage, registerDurableKey, SETTINGS_CHANGED_EVENT } = await import("./durableStorage");

describe("durableStorage adapter", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
  });

  it("reads synchronously from the localStorage cache", () => {
    localStorage.setItem("synthesis-form", "cached");

    expect(durableStorage.getItem("synthesis-form")).toBe("cached");
  });

  it("writes to both the cache and the backend", () => {
    durableStorage.setItem("synthesis-form", "fresh");

    expect(localStorage.getItem("synthesis-form")).toBe("fresh");
    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "synthesis-form", value: "fresh" });
  });

  it("removes from both the cache and the backend", () => {
    localStorage.setItem("synthesis-form", "fresh");

    durableStorage.removeItem("synthesis-form");

    expect(localStorage.getItem("synthesis-form")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("delete_setting", { key: "synthesis-form" });
  });

  // A backend that is down must never break the UI: the cache write already
  // happened, so the user's change survives the session either way.
  it("survives a backend rejection", () => {
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("no db")));

    expect(() => durableStorage.setItem("synthesis-form", "fresh")).not.toThrow();
    expect(localStorage.getItem("synthesis-form")).toBe("fresh");
  });
});

describe("remote settings changes", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
  });

  it("applies a change from the other window", () => {
    const onRemote = vi.fn();
    registerDurableKey("meter-settings", onRemote);

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "meter-settings", value: "from-overlay", origin: "main" },
    });

    expect(localStorage.getItem("meter-settings")).toBe("from-overlay");
    expect(onRemote).toHaveBeenCalledWith("from-overlay");
  });

  it("applies a remote deletion", () => {
    const onRemote = vi.fn();
    registerDurableKey("meter-settings", onRemote);
    localStorage.setItem("meter-settings", "stale");

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "meter-settings", value: null, origin: "main" },
    });

    expect(localStorage.getItem("meter-settings")).toBeNull();
    expect(onRemote).toHaveBeenCalledWith(null);
  });

  // Without this the emitting window would clobber its own newer state with
  // the echo of its own write.
  it("ignores an event it emitted itself", () => {
    const onRemote = vi.fn();
    registerDurableKey("meter-settings", onRemote);

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "meter-settings", value: "echo", origin: "logs" },
    });

    expect(localStorage.getItem("meter-settings")).toBeNull();
    expect(onRemote).not.toHaveBeenCalled();
  });

  it("caches a change for a key no store registered", () => {
    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "unregistered", value: "v", origin: "main" },
    });

    expect(localStorage.getItem("unregistered")).toBe("v");
  });
});
