import { create } from "zustand";

import { deriveNavState } from "@/utils";

/** The header tabs in the logs window. Every route under `/logs` belongs to
 * exactly one of them. */
export type NavTabKey = "logs" | "toolbox" | "settings" | "debug";

/** Where a tab goes when it has nothing remembered — its section entry point. */
export const NAV_TAB_ROOTS: Record<NavTabKey, string> = {
  logs: "/logs",
  toolbox: "/logs/toolbox",
  settings: "/logs/settings",
  debug: "/logs/debug",
};

export type NavLocations = Partial<Record<NavTabKey, string>>;

/** Which tab owns a route. Shares `deriveNavState` with the header so the tab
 * that lights up and the tab that records the visit can never disagree. */
export const tabKeyForPath = (pathname: string): NavTabKey => {
  const { toolboxActive, settingsActive, debugActive } = deriveNavState(pathname);
  if (toolboxActive) return "toolbox";
  if (settingsActive) return "settings";
  if (debugActive) return "debug";
  return "logs";
};

/**
 * Where a header tab should link to. An inactive tab returns to whatever was
 * last open under it — the quest detail, the settings section, the tool — so
 * stepping away and back doesn't lose your place. The *active* tab links to its
 * root instead, keeping the re-click as a "start over" gesture (and the Logs
 * tab as the way out of a quest detail).
 */
export const targetFor = (locations: NavLocations, key: NavTabKey, activeKey: NavTabKey): string =>
  key === activeKey ? NAV_TAB_ROOTS[key] : locations[key] ?? NAV_TAB_ROOTS[key];

type NavMemoryState = {
  locations: NavLocations;
  remember: (pathname: string, search: string) => void;
};

/**
 * Per-tab memory of the last location visited. Deliberately *not* persisted:
 * it lives as long as the app does, so a relaunch opens on the quest list
 * rather than on some quest detail from days ago.
 */
export const useNavMemoryStore = create<NavMemoryState>((set) => ({
  locations: {},
  remember: (pathname, search) =>
    set((state) => ({ locations: { ...state.locations, [tabKeyForPath(pathname)]: `${pathname}${search}` } })),
}));
