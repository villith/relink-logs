import { HookState } from "@/types";

/** Presentation tables for `HookState`, shared by the logs-header badge and
 * the overlay titlebar. They live together, and are exhaustive `Record`s
 * rather than if/else chains, so adding a state fails the build in every place
 * that still needs a row instead of silently falling through to "No game
 * found". */

/** Status-dot colour for the badge. */
export const HOOK_DOT_COLOR: Record<HookState, string> = {
  connected: "#51cf66",
  reconnecting: "#ffd43b",
  outOfDate: "#ffd43b",
  unresponsive: "#ffd43b",
  disconnected: "#868e96",
};

/** Titlebar CSS tone class (drives the `.encounter-status` ::before glyph). */
export const HOOK_TONE_CLASS: Record<HookState, string> = {
  connected: "hook-ok",
  reconnecting: "hook-warn",
  outOfDate: "hook-warn",
  unresponsive: "hook-warn",
  disconnected: "hook-idle",
};

export const HOOK_LABEL_KEY: Record<HookState, string> = {
  connected: "ui.hook-status.connected",
  reconnecting: "ui.hook-status.reconnecting",
  outOfDate: "ui.hook-status.out-of-date",
  unresponsive: "ui.hook-status.unresponsive",
  disconnected: "ui.hook-status.no-game",
};

/** States a re-inject can fix. `reconnecting` is already one in flight, and
 * `disconnected` self-heals via the injection loop. */
export const ACTIONABLE_HOOK_STATES: HookState[] = ["outOfDate", "unresponsive"];
