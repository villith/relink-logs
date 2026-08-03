import { describe, expect, it } from "vitest";

import {
  causeCandidatesFor,
  causeLabel,
  causeNameFor,
  statusIdOfKey,
  statusLabelFor,
  statusRowKindFor,
  targetRowLabel,
  targetRowSegment,
} from "./statusLabel";

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

  it("reads the hook's no-cause sentinels as unattributed", () => {
    // 0xFFFFFFFF is an all-ones u32, the game's own "no value", and 0 is what
    // appliers pass when there is no cause (39 static call sites) — numbers
    // the user can do nothing with, where "unknown source" at least says why.
    expect(causeLabel(0xffffffff)).toBe("");
    expect(causeLabel(0)).toBe("");
    expect(causeLabel(null)).toBe("");
  });
});

describe("causeNameFor", () => {
  it("names a cause through the per-character skill tables", () => {
    // Cause ids in the character bands ARE action ids: 1100 is Id's
    // "Scourge (Dragonform)", statically and live confirmed.
    expect(causeNameFor(1100, () => "Scourge (Dragonform)")).toBe("Scourge (Dragonform)");
  });

  it("falls back to the number when no table names the cause", () => {
    // Better a number than a name fabricated from a numeric coincidence.
    expect(causeNameFor(3300, () => "")).toBe("3300");
  });

  it("reads the sentinels as unattributed without consulting the tables", () => {
    const neverCalled = () => {
      throw new Error("sentinels must not be looked up");
    };
    expect(causeNameFor(0, neverCalled)).toBe("");
    expect(causeNameFor(0xffffffff, neverCalled)).toBe("");
    expect(causeNameFor(null, neverCalled)).toBe("");
  });
});

describe("causeCandidatesFor", () => {
  // A cause is the CASTER's action id, so only the caster's own tables may
  // name it. A party-wide scan provably misattributed: Eustace's supp-DMG
  // cause 1500 took Id's "Ragnarok Form", and Id's own cause 1200 took
  // Eustace's "Play with Fire" purely by party order (measured on log 1636).
  const casters = new Map([
    [0, { characterType: "Pl2700", skillBreakdown: [] }],
    [2, { characterType: "Pl1900", skillBreakdown: [{ childCharacterType: "Pl2000" }, { childCharacterType: "" }] }],
  ]);
  const playerOf = (index: number) => casters.get(index) as never;
  const interval = (statusId: number, abilityId: number | null, casterIndex: number | null) =>
    ({ statusId, abilityId, casterIndex }) as never;

  it("scopes candidates to the casters of the key's own intervals", () => {
    const intervals = [interval(7, 1500, 0), interval(0, 1200, 2)];
    expect(causeCandidatesFor("status:7:1500", intervals, playerOf)).toEqual(["Pl2700"]);
  });

  it("includes the caster's own sub-actor child types", () => {
    // Id's Dragonform Burn arrives from the Pl2000 sub-actor, and only
    // Pl2000's table names its actions — the parent Pl1900 cannot.
    expect(causeCandidatesFor("status:0:1200", [interval(0, 1200, 2)], playerOf)).toEqual(["Pl1900", "Pl2000"]);
  });

  it("answers no candidates when no caster resolves to a player", () => {
    // An unattributed caster, and one that is not a party member: the honest
    // answer is the shared bands and then the number — a name borrowed from
    // whoever happens to be in the party is a fabrication.
    const intervals = [interval(7, 1500, null), interval(7, 1500, 999)];
    expect(causeCandidatesFor("status:7:1500", intervals, playerOf)).toEqual([]);
  });

  it("matches the unknown-cause spelling of the key", () => {
    expect(causeCandidatesFor("status:7:unknown", [interval(7, null, 0)], playerOf)).toEqual(["Pl2700"]);
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

describe("statusIdOfKey", () => {
  it("reads the effect id out of a status key", () => {
    expect(statusIdOfKey("status:1001:1100")).toBe(1001);
    expect(statusIdOfKey("status:10:unknown")).toBe(10);
  });

  it("answers null for anything that is not a status key", () => {
    expect(statusIdOfKey("player:0")).toBeNull();
    expect(statusIdOfKey("Normal:1000")).toBeNull();
  });
});

describe("targetRowSegment", () => {
  it("reads the spawn segment out of a target row", () => {
    expect(targetRowSegment("target:3")).toBe(3);
  });

  it("answers null for actor rows and anything else", () => {
    // A bare actor id indexes nothing a portrait could hang on.
    expect(targetRowSegment("actor:4058884280")).toBeNull();
    expect(targetRowSegment("player:0")).toBeNull();
  });
});
