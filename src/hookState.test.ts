import { describe, expect, it } from "vitest";

import { ACTIONABLE_HOOK_STATES, HOOK_DOT_COLOR, HOOK_LABEL_KEY, HOOK_TONE_CLASS } from "./hookState";
import { HookState } from "./types";

const ALL_STATES: HookState[] = [
  "connected",
  "reconnecting",
  "outOfDate",
  "unresponsive",
  "dllMissing",
  "disconnected",
];

describe("hook state presentation tables", () => {
  it.each(ALL_STATES)("has a colour, tone and label for %s", (state) => {
    expect(HOOK_DOT_COLOR[state]).toBeTruthy();
    expect(HOOK_TONE_CLASS[state]).toBeTruthy();
    expect(HOOK_LABEL_KEY[state]).toBeTruthy();
  });

  // A quarantined DLL is broken, not merely idle: it must not share the grey
  // "no game found" tone that it used to be indistinguishable from.
  it("shows dllMissing as an error rather than an idle state", () => {
    expect(HOOK_DOT_COLOR.dllMissing).not.toBe(HOOK_DOT_COLOR.disconnected);
    expect(HOOK_TONE_CLASS.dllMissing).not.toBe(HOOK_TONE_CLASS.disconnected);
  });

  // Refresh re-injects; there is nothing on disk TO inject, so the badge must
  // offer the help link instead of an action that cannot work.
  it("does not offer a hook refresh for dllMissing", () => {
    expect(ACTIONABLE_HOOK_STATES).not.toContain("dllMissing");
  });
});
