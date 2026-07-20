import { useEffect, useRef, useState } from "react";

/**
 * Latching staleness watcher for toolbox results computed from a snapshot of
 * live game state: while `subject` is non-null, polls `isStale(subject)`
 * every 5s and latches `stale` the first time it reports true. Callers reset
 * via the returned setter when they compute fresh results.
 *
 * `subject` IS the watched result, not a boolean, so a new result tears the
 * previous watch down: a poll still in flight against the old snapshot is
 * cancelled instead of latching `stale` onto results that are actually fresh.
 *
 * Ticks are skipped while the document is hidden (closing a window hides it
 * to the tray rather than exiting, and each check reads game memory); the
 * check also runs on becoming visible again, so a change made while the game
 * covered the window isn't missed. A throwing `isStale` is ignored — game
 * gone means staleness is unknowable, not stale.
 */
export default function useStalenessWatch<T>(
  subject: T | null,
  isStale: (subject: T) => Promise<boolean>
): [boolean, (stale: boolean) => void] {
  const [stale, setStale] = useState(false);
  // Kept in a ref so a re-rendered callback doesn't restart the interval,
  // and written in an effect rather than during render (React forbids the
  // latter — a discarded render would still mutate it).
  const isStaleRef = useRef(isStale);
  useEffect(() => {
    isStaleRef.current = isStale;
  });

  useEffect(() => {
    if (subject === null || stale) return;
    let cancelled = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const result = await isStaleRef.current(subject);
        if (!cancelled && result) setStale(true);
      } catch {
        // Game gone or state unreadable — staleness unknowable; don't flag.
      }
    };
    const id = setInterval(check, 5000);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [subject, stale]);

  return [stale, setStale];
}
