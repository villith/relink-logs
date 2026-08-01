import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve({}));
type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
    return Promise.resolve(() => {});
  },
}));

(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};
// This file is the overlay's half of the contract: every other durable-settings
// test runs as the logs window, so without one that runs as "main" the
// writer-of-record rule is only ever exercised from the writing side.
(window as unknown as { __TAURI_METADATA__: unknown }).__TAURI_METADATA__ = {
  __currentWindow: { label: "main" },
};

const { bootstrapDurableSettings, durableStorage, registerDurableKey, withOverlayWrite, SETTINGS_CHANGED_EVENT } =
  await import("./durableStorage");

describe("the overlay is a reader, not a writer", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve({}));
  });

  /* The logs window owns every setting the user can edit, so the overlay never
     answers back. This is what makes a cross-window echo impossible rather than
     merely suppressed: a loop needs two writers. */
  it("does not persist a store write", () => {
    durableStorage.setItem("meter-settings", "changed-in-overlay");

    expect(invokeMock).not.toHaveBeenCalled();
    // The cache half still happens — the overlay needs a working local copy to
    // paint from on the next launch.
    expect(localStorage.getItem("meter-settings")).toBe("changed-in-overlay");
  });

  it("does not persist a store deletion", () => {
    localStorage.setItem("meter-settings", "present");

    durableStorage.removeItem("meter-settings");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("meter-settings")).toBeNull();
  });

  // Both windows bootstrap at once, so two adopters would race over whose cache
  // wins — and the overlay's copy of the toolbox keys is whatever the store
  // defaults to, because it never renders them.
  it("does not adopt cache-only keys", async () => {
    localStorage.setItem("transmarvel-wishlists", "overlay-copy");

    await bootstrapDurableSettings();

    expect(invokeMock).not.toHaveBeenCalledWith("set_setting", expect.anything());
  });

  // Read-only must not mean deaf: this is the path that carries a settings-page
  // change to the live overlay, and the reason the durable store exists at all.
  it("still applies a change from the logs window", async () => {
    await bootstrapDurableSettings();
    invokeMock.mockClear();
    const onRemote = vi.fn();
    registerDurableKey("meter-settings", onRemote);

    listeners[SETTINGS_CHANGED_EVENT][0]({
      payload: { key: "meter-settings", value: "from-logs", origin: "logs" },
    });

    expect(localStorage.getItem("meter-settings")).toBe("from-logs");
    expect(onRemote).toHaveBeenCalledWith("from-logs");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // The one setting the overlay owns, because it is the only window that can
  // see the user drag its edge.
  it("persists the size it was dragged to", () => {
    withOverlayWrite(() => durableStorage.setItem("meter-settings", "dragged-size"));

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "meter-settings", value: "dragged-size" });
  });

  it("goes back to read-only after that write", () => {
    withOverlayWrite(() => durableStorage.setItem("meter-settings", "dragged-size"));
    invokeMock.mockClear();

    durableStorage.setItem("meter-settings", "something-else");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  // A throwing write must not leave the escape hatch propped open.
  it("goes back to read-only even if the write throws", () => {
    expect(() =>
      withOverlayWrite(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");

    durableStorage.setItem("meter-settings", "after-throw");

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
