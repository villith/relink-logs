import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

/** Emitted by the Rust side on every settings write. */
export const SETTINGS_CHANGED_EVENT = "settings-changed";

/** Emitted by the Rust side after "Reset Settings" deleted every stored key. */
export const SETTINGS_RESET_EVENT = "settings-reset";

type SettingsChanged = { key: string; value: string | null; origin: string };

/** The Tauri event IPC only exists inside a real Tauri window — not in
 * vitest/jsdom or a plain-browser `npm run dev`. */
export const insideTauri = () => "__TAURI_IPC__" in window;

/** The transparent meter overlay's window label (see `tauri.conf.json`). */
const OVERLAY_LABEL = "main";

/** This window's label, read straight from the metadata Tauri injects rather
 * than through `appWindow`: it is a plain property read, so it cannot throw
 * outside Tauri and needs no `allowlist.window` entry.
 *
 * An unknown label falls back to the overlay's, i.e. to *not* being the writer
 * of record — the fail-safe direction. Guessing "writer" instead would make
 * every window a writer the moment the metadata is missing, which is the
 * two-writer arrangement the single-writer rule exists to rule out. Losing the
 * durable copy for a session costs nothing that a restart does not fix;
 * `@tauri-apps/api`'s own window module falls back the same way. */
const currentWindowLabel = (): string =>
  (window as unknown as { __TAURI_METADATA__?: { __currentWindow?: { label?: string } } }).__TAURI_METADATA__
    ?.__currentWindow?.label ?? OVERLAY_LABEL;

/**
 * How deep we are inside the one durable write the overlay owns — see
 * [`withOverlayWrite`]. A depth rather than a flag so a nested call cannot
 * close the hatch while an outer one is still using it.
 */
let overlayWriteDepth = 0;

/**
 * Whether this window may persist to settings.db.
 *
 * The logs window is the writer of record. Every setting the user can edit
 * lives on its settings page, so the overlay is a pure reader: it applies what
 * it is told and never answers back. That is a structural property, not a
 * convention — with a single writer there is no pair of windows that can echo
 * each other's writes at all.
 */
const mayWriteDurably = () => overlayWriteDepth > 0 || currentWindowLabel() !== OVERLAY_LABEL;

/**
 * Let the overlay persist the one change only it can observe: the size the user
 * dragged its edge to. Nothing else it renders is its to own.
 *
 * Synchronous by contract — zustand's persist writes through the storage
 * adapter inline on `set`, so the write lands before this returns.
 */
export const withOverlayWrite = <T>(write: () => T): T => {
  overlayWriteDepth += 1;
  try {
    return write();
  } finally {
    overlayWriteDepth -= 1;
  }
};

/** What to do when a key's value arrives from the backend — either at startup
 * or from the other window. Stores register a rehydrate; i18n registers a
 * language change. */
export type RemoteHandler = (value: string | null) => void;

/** The durable key set, and the only definition of it: registering a key is
 * what makes it durable. Anything unregistered stays purely in localStorage —
 * nav-rail collapse and nav memory are UI ephemera nobody misses. */
const handlers = new Map<string, RemoteHandler>();

/** Whether [`bootstrapDurableSettings`] has already run. */
let bootstrapped = false;

export const registerDurableKey = (key: string, onRemote: RemoteHandler) => {
  handlers.set(key, onRemote);

  // Registering after the bootstrap has already run hydrates immediately, so a
  // key does not depend on its module having been imported before the app
  // awaited bootstrap — the moment a route is code-split, its stores would
  // otherwise register too late and, because of `skipHydration`, sit on
  // defaults forever. The cache is the right source: bootstrap wrote every
  // backend row into it, registered or not.
  if (bootstrapped) applyDurableKey(key, localStorage.getItem(key));
};

/**
 * True while a value that *came from* settings.db is being applied to this
 * window's stores, during which the adapter must not send anything back.
 *
 * A store's handler is `persist.rehydrate()`, and zustand ends rehydration by
 * writing the hydrated state back through the same storage adapter — see
 * `hydrate()` in zustand/middleware, which returns `setItem()`. Applying a
 * change is therefore itself a write. Left unguarded it reaches `set_setting`,
 * the backend rebroadcasts it, the other window rehydrates and writes back,
 * and the two windows ping-pong forever: an unbounded IPC and settings.db
 * write loop that starts at boot, because hydrating the stores is enough to
 * trigger it.
 *
 * A synchronous guard is sufficient, and only because the adapter's `getItem`
 * is synchronous: zustand's `toThenable` runs the whole hydrate chain inline
 * for a non-Promise result, so the write-back happens before the `finally`
 * below. Keep `getItem` synchronous — it is also what stops the transparent
 * overlay painting default columns for a frame.
 *
 * A depth rather than a boolean: a handler that reaches another key's handler
 * synchronously would otherwise have the inner `finally` clear the guard, and
 * the rest of the outer handler's write-back would escape to the backend.
 */
let applyingRemoteDepth = 0;

/** Run a key's handler, if it has one. Used by both the remote listener and
 * the startup reconciliation, so the two can never drift apart. */
export const applyDurableKey = (key: string, value: string | null) => {
  const handler = handlers.get(key);
  if (!handler) return;

  applyingRemoteDepth += 1;
  try {
    handler(value);
  } finally {
    applyingRemoteDepth -= 1;
  }
};

/**
 * The zustand `StateStorage` behind every durable store.
 *
 * Reads come from localStorage and are synchronous on purpose: the overlay is
 * transparent and paints its columns and bar colours on the first frame, so an
 * async read would show defaults for a frame. Writes go to both places, and a
 * backend failure is logged and swallowed — the user's change already landed
 * in the cache, and nothing here may throw into a React render.
 *
 * The cache half of a write always happens — every window keeps a working
 * localStorage copy. Only the backend half is conditional: it is skipped while
 * applying a remote change (the backend is where that value came from), and in
 * the overlay, which is not the writer of record.
 */
const persistable = () => insideTauri() && applyingRemoteDepth === 0 && mayWriteDurably();

/** The backend half of a write; `null` deletes. The single path to
 * settings.db, so every rule about who may write and when is stated once.
 * Never rejects — the user's change already landed in the cache, and nothing
 * here may throw into a React render. */
const persistToBackend = (key: string, value: string | null): Promise<void> => {
  if (!persistable()) return Promise.resolve();

  const request = value === null ? invoke("delete_setting", { key }) : invoke("set_setting", { key, value });
  return request.then(
    () => undefined,
    (e) => console.warn(`[settings] failed to write ${key}:`, e)
  );
};

export const durableStorage: StateStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value);
    void persistToBackend(key, value);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
    void persistToBackend(key, null);
  },
};

/** A persisted zustand store, structurally — the slice of its `persist` API
 * this module drives. */
type PersistedStore = {
  persist: { getOptions: () => { name?: string }; rehydrate: () => void | Promise<void> };
};

/**
 * The persist options every durable store shares. Spread into `persist`'s
 * second argument alongside `name`, `version` and any store-specific
 * `migrate`/`merge`.
 *
 * Hydration is driven by [`bootstrapDurableSettings`], which runs after
 * settings.db has had its say — hydrating at import time would load the cache
 * copy and then get overwritten, hence `skipHydration`.
 */
export const durablePersistOptions = <S>() => ({
  storage: createJSONStorage<S>(() => durableStorage),
  skipHydration: true as const,
});

/**
 * Make a store's persisted state durable: hydrate it at bootstrap and reapply
 * it whenever the other window changes it.
 *
 * Takes the key off the store rather than a second string literal, so the
 * persist `name` and the registered key cannot drift — a mismatch would hydrate
 * nothing, silently, because `skipHydration` means no hydration is also what a
 * working store looks like on the first frame.
 */
export const registerDurableStore = (store: PersistedStore) => {
  // `name` is required by zustand's persist options, so this is never null.
  const { name } = store.persist.getOptions();
  if (name) registerDurableKey(name, () => void store.persist.rehydrate());
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

  // Writer of record only. Both windows reach this point at once, so letting
  // both adopt would race over whose cache wins — and the overlay's is the one
  // to lose: it never renders the toolbox, so its copy of those keys is
  // whatever the store defaults to. On Windows the two caches are the same
  // localStorage anyway; on Linux, where they are not (tauri-apps/tauri#10981),
  // the logs window's copy is the complete one.
  if (persistable()) {
    const adoptions: Promise<unknown>[] = [];

    for (const key of handlers.keys()) {
      if (key in rows) continue;
      const cached = localStorage.getItem(key);
      if (cached === null) continue;

      adoptions.push(persistToBackend(key, cached));
    }

    // Awaited, not fired and forgotten: adoption is the one-shot migration of
    // an existing user's settings, and it runs on exactly the launch where
    // localStorage is most likely to be wiped out from under it. `allSettled`
    // so one unwritable key cannot stop the app from starting. Costs nothing
    // after the first launch, when there is nothing left to adopt.
    await Promise.allSettled(adoptions);
  }

  for (const key of handlers.keys()) {
    applyDurableKey(key, localStorage.getItem(key));
  }

  // Anything registered from here on hydrates itself — see `registerDurableKey`.
  bootstrapped = true;
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

  /* "Reset Settings" cannot go through the per-key channel: rehydrating a
     store from a key that no longer exists leaves its in-memory state exactly
     as it was — zustand only merges what it finds. So every window drops the
     deleted keys from its cache (plus every registered key, belt and braces —
     an unregistered cached copy would otherwise be adopted back into the
     backend at the next bootstrap) and reloads; a fresh boot over an empty
     store is precisely the defaults. */
  void listen<{ keys: string[] }>(SETTINGS_RESET_EVENT, ({ payload }) => {
    for (const key of new Set([...payload.keys, ...handlers.keys()])) {
      localStorage.removeItem(key);
    }
    window.location.reload();
  });
}
