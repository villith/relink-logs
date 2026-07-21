import { invoke } from "@tauri-apps/api";
import { useEffect, useState } from "react";

/**
 * Live game status for a toolbox tool: fetches `command` once on mount and
 * re-fetches whenever the window becomes visible again — users routinely open
 * a tool before launching the game, so the "game not running" banner (and
 * anything built from the status, like the roster picker) recovers on its own.
 *
 * `error`/`setError` are returned for the tool's action calls (search/predict)
 * to share, matching the single error banner each tool shows.
 */
export default function useGameStatus<T>(command: string) {
  const [status, setStatus] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () =>
      invoke<T>(command)
        .then((next) => {
          setStatus(next);
          // Clear the banner on success, otherwise the re-read this hook exists for can
          // populate the tool and still leave "game not running" pinned above it forever.
          setError(null);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    load();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [command]);

  return { status, error, setError, loading };
}
