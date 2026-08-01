import { invoke } from "@tauri-apps/api";
import toast from "react-hot-toast";
import { create } from "zustand";

import { Log, LogSortType, SortDirection, StoredLegalityFinding } from "@/types";

import { useMeterSettingsStore } from "./useMeterSettingsStore";

export type SearchResult = {
  logs: Log[];
  page: number;
  pageCount: number;
  logCount: number;
  enemyIds: number[];
  questIds: number[];
  playerIds: string[];
  playerTypes: string[];
  /** Stored build-legality verdicts for the logs on this page, keyed by log id.
   * Arrives with the page so a row and its verdicts are never a render apart.
   * A log nobody was flagged in has no entry — a miss reads as clean. */
  legality: Record<string, StoredLegalityFinding[]>;
};

const DEFAULT_SEARCH_RESULT = {
  logs: [],
  page: 1,
  pageCount: 0,
  logCount: 0,
  enemyIds: [],
  questIds: [],
  playerIds: [],
  playerTypes: [],
  legality: {},
};

type LogIndexState = {
  currentPage: number;
  searchResult: SearchResult;
  filters: FilterState;
  selectedLogIds: number[];
  setSearchResult: (result: SearchResult) => void;
  setFilters: (filters: Partial<FilterState>) => void;
  setCurrentPage: (page: number) => void;
  setSelectedLogIds: (ids: number[]) => void;
  deleteSelectedLogs: () => void;
  deleteAllLogs: () => void;
  /** Deletes every imported log and refetches; resolves to how many went.
   * Throws on failure so the caller can phrase the error toast. */
  deleteImportedLogs: () => Promise<number>;
  fetchLogs: () => void;
};

export type FilterState = {
  filterByEnemyId: number | null;
  filterByQuestId: number | null;
  sortDirection: SortDirection;
  sortType: LogSortType;
  questCompletedFilter: boolean | null;
  filterByPlayerId: string | null;
  filterByPlayerCharacter: string | null;
  /** Show only the quests somebody was flagged in. Only reaches the backend
   * while flagged builds are shown app-wide — see `fetchLogs`. */
  flaggedOnly: boolean;
  showAdvancedFilters: boolean;
};

const DEFAULT_FILTERS: FilterState = {
  filterByEnemyId: null,
  filterByQuestId: null,
  sortDirection: "desc",
  sortType: "time",
  questCompletedFilter: null,
  filterByPlayerId: null,
  filterByPlayerCharacter: null,
  flaggedOnly: false,
  showAdvancedFilters: false,
};

export const useLogIndexStore = create<LogIndexState>((set, get) => ({
  currentPage: 1,
  searchResult: DEFAULT_SEARCH_RESULT,
  filters: DEFAULT_FILTERS,
  selectedLogIds: [],
  setCurrentPage: (page: number) => set({ currentPage: page }),
  // Normalised on the way in: a response is not guaranteed to carry `legality`
  // — a backend older than the field does not, which in development is simply
  // the binary that has not been rebuilt yet — and the quest list indexes it
  // while rendering, where a missing object throws the page away rather than
  // degrading. Absent reads as "nobody flagged".
  setSearchResult: (result) => set({ searchResult: { ...result, legality: result.legality ?? {} } }),
  setFilters: (filters: Partial<FilterState>) =>
    set((state) => ({ currentPage: 1, filters: { ...state.filters, ...filters } })),
  setSelectedLogIds: (ids) => set({ selectedLogIds: ids }),
  deleteSelectedLogs: async () => {
    const { currentPage, searchResult, fetchLogs, selectedLogIds: ids } = get();

    try {
      await invoke("delete_logs", { ids });
      toast.success("Logs deleted successfully.");
      const newPage = Math.min(currentPage, searchResult.pageCount - 1);
      set({ currentPage: newPage, selectedLogIds: [] });
      await fetchLogs();
    } catch (e) {
      toast.error(`Failed to delete logs: ${e}`);
    }
  },
  deleteAllLogs: async () => {
    const { setSearchResult } = get();

    try {
      await invoke("delete_all_logs");
      set({ currentPage: 1, selectedLogIds: [], searchResult: DEFAULT_SEARCH_RESULT });
      toast.success("Logs deleted successfully.");
      const result = await invoke("fetch_logs");
      setSearchResult(result as SearchResult);
    } catch (e) {
      toast.error(`Failed to delete logs: ${e}`);
    }
  },
  deleteImportedLogs: async () => {
    const { fetchLogs } = get();

    const count = await invoke<number>("delete_imported_logs");
    // The same index reset the sibling deletes do: the current page may no
    // longer exist and the selection may name deleted rows.
    set({ currentPage: 1, selectedLogIds: [] });
    await fetchLogs();
    return count;
  },
  fetchLogs: async () => {
    const { currentPage, filters, setSearchResult } = get();

    try {
      const result = await invoke("fetch_logs", {
        page: currentPage,
        filterByEnemyId: filters.filterByEnemyId,
        filterByQuestId: filters.filterByQuestId,
        filterByPlayerId: filters.filterByPlayerId,
        filterByPlayerCharacter: filters.filterByPlayerCharacter,
        sortDirection: filters.sortDirection,
        sortType: filters.sortType,
        questCompleted: filters.questCompletedFilter,
        // Read here rather than stored here: with flagged builds hidden
        // app-wide the control is hidden too, and a remembered choice must not
        // go on filtering results the user can no longer see a reason for.
        // Ignored, not forgotten — turning the setting back on restores it.
        flaggedOnly: useMeterSettingsStore.getState().show_flagged_builds && filters.flaggedOnly,
      });

      setSearchResult(result as SearchResult);
    } catch (e) {
      toast.error(`Failed to fetch logs: ${e}`);
    }
  },
}));
