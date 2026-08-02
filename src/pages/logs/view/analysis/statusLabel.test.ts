import { describe, expect, it } from "vitest";

import { targetRowLabel } from "./statusLabel";

import { buffs } from "../metrics/buffs";
import { debuffs } from "../metrics/debuffs";

import { statusLabelFor, statusRowKindFor } from "./statusLabel";

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
  it("calls unpinned rows effects", () => {
    expect(statusRowKindFor(buffs.labelKind, null)).toBe("status");
    expect(statusRowKindFor(debuffs.labelKind, null)).toBe("status");
  });

  it("calls a pinned buff's rows players and a pinned debuff's rows targets", () => {
    // The rows really are holders here — `statusRows` builds them off the same
    // pin — so anything else labels an actor as an effect, or an effect key as
    // a player and prints NaN. A debuff holder is an enemy SPAWN, which is what
    // carries a name and a "#n"; it used to be the bare recycled actor id.
    expect(statusRowKindFor(buffs.labelKind, "status:10:500")).toBe("player");
    expect(statusRowKindFor(debuffs.labelKind, "status:10:500")).toBe("target");
  });

  it("ignores a damage pin, which selects no effect", () => {
    // Arriving from the Damage tab must leave the effect rows named as effects.
    expect(statusRowKindFor(buffs.labelKind, "skill:Normal-1234")).toBe("status");
  });

  it("does not consult the row level, which is blind to a status pin", () => {
    // The regression this exists to catch: `rowLevelFor` returns "players" for a
    // pinned buff with no source, so `labelKind(level)` answered "status" over
    // rows that were actors.
    expect(statusRowKindFor(buffs.labelKind, "status:10:500")).not.toBe(buffs.labelKind("players"));
  });
});

describe("statusLabelFor fallbacks", () => {
  it("hands back anything that is not a status key", () => {
    // A stale or hand-edited pin: showing it back is what tells the user why.
    expect(statusLabelFor("skill:Normal-1234", t, { effect: () => "", cause: () => "" })).toBe("skill:Normal-1234");
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
