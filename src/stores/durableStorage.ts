import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import type { StateStorage } from "zustand/middleware";

/** Emitted by the Rust side on every settings write. */
export const SETTINGS_CHANGED_EVENT = "settings-changed";

type SettingsChanged = { key: string; value: string | null; origin: string };

/** Every key the app owns durably. Anything not listed here stays purely in
 * localStorage: nav-rail collapse and nav memory are UI ephemera nobody
 * misses. Order is irrelevant; membership is what the reconciliation reads. */
export const DURABLE_KEYS = [
  "meter-settings",
  "checklist-settings",
  "overmastery-selections",
  "synthesis-form",
  "transmarvel-wishlists",
  "i18nextLng",
] as const;

/** The Tauri event IPC only exists inside a real Tauri window — not in
 * vitest/jsdom or a plain-browser `npm run dev`. */
const insideTauri = () => "__TAURI_IPC__" in window;

/** This window's label, read straight from the metadata Tauri injects rather
 * than through `appWindow`: it is a plain property read, so it cannot throw
 * outside Tauri and needs no `allowlist.window` entry. */
const currentWindowLabel = (): string =>
  (window as unknown as { __TAURI_METADATA__?: { __currentWindow?: { label?: string } } }).__TAURI_METADATA__
    ?.__currentWindow?.label ?? "";

/** What to do when a key's value arrives from the backend — either at startup
 * or from the other window. Stores register a rehydrate; i18n registers a
 * language change. */
export type RemoteHandler = (value: string | null) => void;

const handlers = new Map<string, RemoteHandler>();

export const registerDurableKey = (key: string, onRemote: RemoteHandler) => {
  handlers.set(key, onRemote);
};

/** Run a key's handler, if it has one. Used by both the remote listener and
 * the startup reconciliation, so the two can never drift apart. */
export const applyDurableKey = (key: string, value: string | null) => {
  handlers.get(key)?.(value);
};

/**
 * The zustand `StateStorage` behind every durable store.
 *
 * Reads come from localStorage and are synchronous on purpose: the overlay is
 * transparent and paints its columns and bar colours on the first frame, so an
 * async read would show defaults for a frame. Writes go to both places, and a
 * backend failure is logged and swallowed — the user's change already landed
 * in the cache, and nothing here may throw into a React render.
 */
export const durableStorage: StateStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value);
    if (insideTauri()) {
      void invoke("set_setting", { key, value }).catch((e) => console.warn(`[settings] failed to persist ${key}:`, e));
    }
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
    if (insideTauri()) {
      void invoke("delete_setting", { key }).catch((e) => console.warn(`[settings] failed to delete ${key}:`, e));
    }
  },
};

/* One listener replaces the whole per-store broadcast arrangement this file
   supersedes: the backend is the only writer of record, so it is also the only
   thing that needs to announce a change. Works on Linux, where WebKitGTK
   neither shares localStorage between windows nor fires cross-window `storage`
   events (tauri-apps/tauri#10981). */
if (insideTauri()) {
  void listen<SettingsChanged>(SETTINGS_CHANGED_EVENT, ({ payload }) => {
    if (payload.origin === currentWindowLabel()) return;

    if (payload.value === null) localStorage.removeItem(payload.key);
    else localStorage.setItem(payload.key, payload.value);

    applyDurableKey(payload.key, payload.value);
  });
}
