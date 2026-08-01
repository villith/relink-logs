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

/** Push a value the adapter does not own to the backend. i18next's detector
 * writes `i18nextLng` to localStorage itself, so only the durable half is
 * missing. */
export const writeDurable = (key: string, value: string) => {
  if (!insideTauri()) return;

  void invoke("set_setting", { key, value }).catch((e) => console.warn(`[settings] failed to persist ${key}:`, e));
};

/**
 * Reconcile the durable copy with the cache, then hydrate every registered
 * key. Runs once, before the first render (see `src/main.tsx`).
 *
 * Order matters and is the whole design:
 *   1. the backend copy wins over the cache, repairing a wiped webview store;
 *   2. a key the cache has and the backend does not is adopted, which is how
 *      an existing user's settings survive the release that ships this;
 *   3. every registered key's handler runs, hydrating stores that were built
 *      with `skipHydration`.
 *
 * A backend failure is not fatal: step 3 still runs against the cache, so the
 * app behaves exactly as it did before this existed.
 */
export const bootstrapDurableSettings = async (): Promise<void> => {
  let rows: Record<string, string> = {};

  if (insideTauri()) {
    try {
      rows = await invoke<Record<string, string>>("get_settings");
    } catch (e) {
      console.warn("[settings] backend unavailable, falling back to localStorage:", e);
    }
  }

  for (const [key, value] of Object.entries(rows)) {
    localStorage.setItem(key, value);
  }

  if (insideTauri()) {
    for (const key of DURABLE_KEYS) {
      if (key in rows) continue;
      const cached = localStorage.getItem(key);
      if (cached === null) continue;

      void invoke("set_setting", { key, value: cached }).catch((e) =>
        console.warn(`[settings] failed to adopt ${key}:`, e)
      );
    }
  }

  for (const key of handlers.keys()) {
    applyDurableKey(key, localStorage.getItem(key));
  }
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
