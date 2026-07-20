/**
 * Structured error slugs returned by the toolbox Tauri commands
 * (src-tauri/src/main.rs) mapped to friendly copy keys, per tool. Any error
 * NOT in a tool's map is a free-form message meant to be shown to the user
 * verbatim. Keep in sync with the Rust side.
 */
const TOOL_ERRORS = {
  synthesis: {
    "invalid-trait": "ui.toolbox.invalid-trait",
    "game-not-running": "ui.toolbox.game-not-running",
  },
  overmastery: {
    "game-not-running": "ui.toolbox.om-game-not-running",
    "character-not-found": "ui.toolbox.om-character-not-found",
    "rng-override-active": "ui.toolbox.om-rng-override-active",
    "invalid-tier": "ui.toolbox.om-invalid-tier",
    "slot-out-of-range": "ui.toolbox.om-slot-out-of-range",
  },
} as const satisfies Record<string, Record<string, string>>;

/** Friendly copy for a backend error, or the raw message when unmapped. */
export const backendErrorMessage = (
  t: (key: string) => string,
  tool: keyof typeof TOOL_ERRORS,
  error: string | null
): string | null => {
  if (!error) return error;
  // Own-property check: a raw index would resolve Object.prototype members,
  // so an error string like "toString" would hand a function to `t`.
  const map: Record<string, string> = TOOL_ERRORS[tool];
  return Object.hasOwn(map, error) ? t(map[error]) : error;
};
