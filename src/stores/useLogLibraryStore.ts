import { invoke } from "@tauri-apps/api";
import { t } from "i18next";
import toast from "react-hot-toast";
import { create } from "zustand";

import type { LogSummary } from "@/types";

type LogLibraryState = {
  logs: LogSummary[];
  loaded: boolean;
  loading: boolean;
  /** How many times the library has been invalidated — the generation an
   * in-flight fetch checks itself against before claiming to be current. */
  invalidations: number;
  /** Fetch the library, at most once. Idempotent because the picker renders
   * once per pane and every one of them calls this on mount. */
  load: () => Promise<void>;
  /** Forget that the library was fetched, so the next `load()` asks again.
   * Called wherever the log SET changes — a fight saved, logs deleted, an
   * import — because nothing else would ever refresh this: the logs window
   * lives in the tray for the whole session, so a load-once cache goes stale
   * by exactly the runs recorded since it loaded, and a picker asked to draw
   * one of those has no summary for it and shows a bare id.
   *
   * The logs stay in place until the refetch lands: a picker that emptied
   * itself for a moment on every save would flicker. Mounted views re-ask
   * because they watch `loaded` (see `AnalysisView`). */
  invalidate: () => void;
};

/** The pickable log library. Its OWN store rather than a corner of the panes
 * store: it describes what CAN be opened, not what is open. Separate from
 * `useLogIndexStore` too — that one is the quest list's paginated, filtered,
 * sorted view, and the picker needs the opposite: everything, once, unsorted by
 * anything the user chose elsewhere. */
export const useLogLibraryStore = create<LogLibraryState>((set, get) => ({
  logs: [],
  loaded: false,
  loading: false,
  invalidations: 0,
  load: async () => {
    const { loaded, loading } = get();
    if (loaded || loading) return;
    set({ loading: true });
    try {
      // Re-asks when a save or a delete landed WHILE the fetch was in flight:
      // that response was already stale on arrival, and the invalidation it
      // raced would otherwise be lost behind the `loading` guard above.
      for (;;) {
        const asked = get().invalidations;
        const logs = await invoke<LogSummary[]>("fetch_log_summaries");
        if (get().invalidations === asked) {
          set({ logs, loaded: true, loading: false });
          return;
        }
        set({ logs });
      }
    } catch (e) {
      // A backend older than the command (dev HMR skew) leaves the picker
      // empty rather than throwing the page away — the same degrade-at-the-
      // boundary rule `groups` and `legality` already follow.
      //
      // `loaded` stays FALSE, which is the whole of what makes the degrade
      // temporary: the guard above reads it as "already fetched", so latching
      // it on a failure wedges every pane's picker empty for the rest of the
      // session with nothing able to ask again. Left false, the next mount —
      // another pane, a navigation back to a log — retries.
      toast.error(t("ui.logs.picker-load-failed", { error: String(e) }));
      set({ logs: [], loaded: false, loading: false });
    }
  },
  invalidate: () => set((state) => ({ loaded: false, invalidations: state.invalidations + 1 })),
}));
