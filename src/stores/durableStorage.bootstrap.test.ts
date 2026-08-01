import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve({}));

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "logs" },
};

const { bootstrapDurableSettings, registerDurableKey } = await import("./durableStorage");

describe("bootstrapDurableSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve({}));
  });

  // The whole point: the app-owned copy outranks whatever the webview kept,
  // so a wiped or clobbered localStorage is repaired on the next launch.
  it("lets the backend copy win over the cache", async () => {
    localStorage.setItem("meter-settings", "stale-cache");
    invokeMock.mockImplementation((cmd) =>
      cmd === "get_settings" ? Promise.resolve({ "meter-settings": "durable" }) : Promise.resolve()
    );

    await bootstrapDurableSettings();

    expect(localStorage.getItem("meter-settings")).toBe("durable");
  });

  // How every existing user's data survives the release that ships this.
  it("adopts a cache-only key into the backend", async () => {
    localStorage.setItem("transmarvel-wishlists", "user-data");

    await bootstrapDurableSettings();

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "transmarvel-wishlists",
      value: "user-data",
    });
  });

  it("does not adopt a key the backend already has", async () => {
    localStorage.setItem("synthesis-form", "cached");
    invokeMock.mockImplementation((cmd) =>
      cmd === "get_settings" ? Promise.resolve({ "synthesis-form": "durable" }) : Promise.resolve()
    );

    await bootstrapDurableSettings();

    expect(invokeMock).not.toHaveBeenCalledWith("set_setting", expect.anything());
  });

  it("runs each registered key's handler with the reconciled value", async () => {
    const onRemote = vi.fn();
    registerDurableKey("checklist-settings", onRemote);
    invokeMock.mockImplementation((cmd) =>
      cmd === "get_settings" ? Promise.resolve({ "checklist-settings": "durable" }) : Promise.resolve()
    );

    await bootstrapDurableSettings();

    expect(onRemote).toHaveBeenCalledWith("durable");
  });

  // Stores use skipHydration, so a key with nothing stored anywhere must still
  // get its handler called or the store would sit on defaults forever.
  it("runs the handler with null when nothing is stored", async () => {
    const onRemote = vi.fn();
    registerDurableKey("overmastery-selections", onRemote);

    await bootstrapDurableSettings();

    expect(onRemote).toHaveBeenCalledWith(null);
  });

  // A failed fetch must still hydrate every store from the cache, or the app
  // would render defaults over the user's real settings.
  it("still hydrates from the cache when the backend is unavailable", async () => {
    const onRemote = vi.fn();
    registerDurableKey("meter-settings", onRemote);
    localStorage.setItem("meter-settings", "cached");
    invokeMock.mockImplementation(() => Promise.reject(new Error("no db")));

    await expect(bootstrapDurableSettings()).resolves.toBeUndefined();

    expect(onRemote).toHaveBeenCalledWith("cached");
  });
});
