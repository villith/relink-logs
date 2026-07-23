import { beforeEach, describe, expect, it, vi } from "vitest";

// Cross-window settings sync must go over Tauri events carrying the changed
// values: on Linux (WebKitGTK) webviews neither share localStorage nor fire
// cross-window `storage` events (tauri-apps/tauri#10981), so the persist
// middleware's storage alone never reaches the overlay window.

const emitMock = vi.fn<[string, unknown], Promise<void>>(() => Promise.resolve());
type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => emitMock(event, payload),
  listen: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
    return Promise.resolve(() => {});
  },
}));

// The store only wires the sync up inside a real Tauri window; fake one
// before the module-scope registration runs.
(window as unknown as { __TAURI_IPC__: unknown }).__TAURI_IPC__ = () => {};

const { useMeterSettingsStore, SETTINGS_SYNC_EVENT, LANGUAGE_SYNC_EVENT } = await import("./useMeterSettingsStore");

describe("meter settings cross-window sync", () => {
  beforeEach(() => {
    emitMock.mockClear();
  });

  it("registers Tauri event listeners for settings and language", () => {
    expect(listeners[SETTINGS_SYNC_EVENT]).toHaveLength(1);
    expect(listeners[LANGUAGE_SYNC_EVENT]).toHaveLength(1);
  });

  it("broadcasts changed settings to the other window on set()", () => {
    useMeterSettingsStore.getState().set({ transparency: 0.55 });

    expect(useMeterSettingsStore.getState().transparency).toBe(0.55);
    expect(emitMock).toHaveBeenCalledWith(SETTINGS_SYNC_EVENT, { transparency: 0.55 });
  });

  it("applies a received broadcast without re-broadcasting", () => {
    listeners[SETTINGS_SYNC_EVENT][0]({ payload: { transparency: 0.9, show_display_names: false } });

    expect(useMeterSettingsStore.getState().transparency).toBe(0.9);
    expect(useMeterSettingsStore.getState().show_display_names).toBe(false);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("switches language on a received language broadcast", () => {
    const changeLanguage = vi.fn();
    window.i18n = { language: "en", changeLanguage };

    listeners[LANGUAGE_SYNC_EVENT][0]({ payload: "jp" });
    expect(changeLanguage).toHaveBeenCalledWith("jp");

    // Already speaking the broadcast language (the emitting window hears its
    // own event) — must not re-trigger a change.
    changeLanguage.mockClear();
    listeners[LANGUAGE_SYNC_EVENT][0]({ payload: "en" });
    expect(changeLanguage).not.toHaveBeenCalled();
  });
});
