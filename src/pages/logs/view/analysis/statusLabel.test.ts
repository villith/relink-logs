import { describe, expect, it } from "vitest";

import { causeLabel, statusLabelFor, statusRowKindFor, targetRowLabel } from "./statusLabel";

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

describe("statusRowKindFor", () => {
  it("answers status when nothing is pinned, whatever the hostility", () => {
    expect(statusRowKindFor(null, "friendly")).toBe("status");
    expect(statusRowKindFor("120", "enemy")).toBe("status");
  });

  it("answers the holder kind for a status pin from the hostility", () => {
    // The kind used to come from which TAB was open; with the hostility
    // switch, a Debuffs table over friendly holders shows PLAYER rows.
    expect(statusRowKindFor("status:10:500", "friendly")).toBe("player");
    expect(statusRowKindFor("status:10:500", "enemy")).toBe("target");
  });
});

describe("statusLabelFor fallbacks", () => {
  it("hands back anything that is not a status key", () => {
    // A stale or hand-edited pin: showing it back is what tells the user why.
    expect(statusLabelFor("skill:Normal-1234", t, { effect: () => "", cause: () => "" })).toBe("skill:Normal-1234");
  });
});

describe("causeLabel", () => {
  it("shows the discriminator, which is what keeps two same-effect rows apart", () => {
    expect(causeLabel(11000)).toBe("11000");
  });

  it("reads the hook's no-cause sentinel as unattributed", () => {
    // 0xFFFFFFFF is an all-ones u32, the game's own "no value" — a number the
    // user can do nothing with, where "unknown source" at least says why.
    expect(causeLabel(0xffffffff)).toBe("");
    expect(causeLabel(null)).toBe("");
  });
});

describe("targetRowLabel", () => {
  it("names a segmented enemy through the target labels", () => {
    // The whole point: a spawn has a name and a "#n", the recycled actor id
    // behind it has neither.
    expect(targetRowLabel("target:2", (segment) => `Enemy #${segment}`)).toBe("Enemy #2");
  });

  it("shows the raw id for an enemy the segmenter never placed", () => {
    // A phantom marker actor has no segment, so there is nothing to name it
    // with — but its row must still say which actor it was.
    expect(targetRowLabel("actor:4058884280", () => "unused")).toBe("4058884280");
  });

  it("hands back anything else untouched", () => {
    expect(targetRowLabel("player:0", () => "unused")).toBe("player:0");
  });
});
