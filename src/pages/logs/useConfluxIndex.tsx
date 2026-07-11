import { ConfluxSearchResult } from "@/types";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

const EMPTY: ConfluxSearchResult = { runs: [], page: 1, pageCount: 1, runCount: 0 };

export default function useConfluxIndex() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ConfluxSearchResult>(EMPTY);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await invoke<ConfluxSearchResult>("fetch_conflux_runs", { page });
      setResult(res);
    } catch (e) {
      console.error("fetch_conflux_runs failed", e);
      setResult(EMPTY);
    }
  }, [page]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    const l = listen("conflux-run-saved", () => fetchRuns());
    return () => {
      l.then((f) => f());
    };
  }, [fetchRuns]);

  return { result, page, setPage };
}
