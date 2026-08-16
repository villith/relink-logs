import { invoke } from "@tauri-apps/api";
import { t } from "i18next";
import toast from "react-hot-toast";
import { create } from "zustand";

import type { LogSummary } from "@/types";

type LogLibraryState = {
  logs: LogSummary[];
  loaded: boolean;
  loading: boolean;
  /** Fetch the library, at most once. Idempotent because the picker renders
   * once per pane and every one of them calls this on mount. */
  load: () => Promise<void>;
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
  load: async () => {
    const { loaded, loading } = get();
    if (loaded || loading) return;
    set({ loading: true });
    try {
      const logs = await invoke<LogSummary[]>("fetch_log_summaries");
      set({ logs, loaded: true, loading: false });
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
}));
