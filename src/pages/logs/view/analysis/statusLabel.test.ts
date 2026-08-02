import { describe, expect, it } from "vitest";

import { targetRowLabel } from "./statusLabel";

import { statusLabelFor } from "./statusLabel";

// Stands in for i18next: the real thing interpolates the same way.
const t = (key: string, vars?: Record<string, unknown>): string =>
  key === "ui.logs.buff-label"
    ? `${vars?.effect} (${vars?.cause})`
    : key === "ui.logs.buff-cause-unknown"
      ? "unknown source"
      : key === "ui.logs.buff-effect-unnamed"
        ? `Effect ${vars?.id}`
        : key;

describe("statusLabelFor", () => {
  it("reads as the effect with its cause in parentheses", () => {
    expect(statusLabelFor("status:10:500", t, { effect: () => "Attack Up", cause: () => "Signo Drive" })).toBe(
      "Attack Up (Signo Drive)"
    );
  });

  it("names an unresolved cause rather than dropping the row", () => {
    // The documented fallback for an ability_id the hook could not attribute.
    expect(statusLabelFor("status:10:unknown", t, { effect: () => "Attack Up", cause: () => "" })).toBe(
      "Attack Up (unknown source)"
    );
  });

  it("falls back to the raw effect id when no name exists for it", () => {
    // status.tbl is not extracted yet, so this is the shipping path.
    expect(statusLabelFor("status:10:500", t, { effect: () => "", cause: () => "500" })).toBe("Effect 10 (500)");
  });

  it("hands back anything that is not a status key", () => {
    // A stale or hand-edited pin: showing it back is what tells the user why.
    expect(statusLabelFor("skill:Normal-1234", t, { effect: () => "", cause: () => "" })).toBe("skill:Normal-1234");
  });
});
