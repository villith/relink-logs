/**
 * Structured error strings returned by the synthesis Tauri commands
 * (src-tauri/src/main.rs). Any error NOT in this set is a free-form message
 * meant to be shown to the user verbatim. Keep in sync with the Rust side.
 */
export const SYNTHESIS_ERR = {
  invalidTrait: "invalid-trait",
  gameNotRunning: "game-not-running",
} as const;
