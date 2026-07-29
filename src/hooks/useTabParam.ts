import { useQueryState } from "nuqs";

import { resolveAvailableTab } from "@/utils";

/**
 * A page's selected tab, held in the URL as `?tab=` rather than in component
 * state. Putting it in the route is what lets the header's per-tab memory
 * restore it: coming back to a quest detail returns to the tab that was open
 * inside it, with no second store to keep in sync.
 *
 * `available` is the set of tabs the page can show *right now* — pass the
 * shorter list while data is missing and a URL naming a disabled tab falls back
 * to `fallback` until that tab becomes selectable. The narrowing happens on
 * every render rather than through a `parseAsStringLiteral` parser, which
 * caches its parse and would keep the fallback after the data arrives.
 *
 * Updates replace the history entry; pushing would turn every tab click into a
 * Back-button stop.
 */
export const useTabParam = <T extends string>(available: readonly T[], fallback: T) => {
  const [raw, setRaw] = useQueryState("tab", { history: "replace" });
  // nuqs' setter takes any string, so it can be handed straight to Mantine's
  // `Tabs.onChange`, which hands back the clicked tab's value untyped; the read
  // side is narrowed here regardless.
  return [resolveAvailableTab(raw, available, fallback), setRaw] as const;
};
