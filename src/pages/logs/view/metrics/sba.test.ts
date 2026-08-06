import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { SBA_UNATTRIBUTED_KEY, sba, sbaCauseLabel } from "./sba";

const player = (
  index: number,
  values: {
    sba: number;
    sbaGenerated?: number;
    skillBreakdown?: { action: number; damage?: number; sbaGenerated?: number }[];
    sbaSources?: { kind: string; id?: number; generated: number }[];
  }
) =>
  ({
    sbaSources: (values.sbaSources ?? []).map((s) => ({ kind: s.kind, id: s.id ?? null, generated: s.generated })),
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: 0,
    dps: 0,
    percentage: 0,
    sba: values.sba,
    sbaGenerated: values.sbaGenerated,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: (values.skillBreakdown ?? []).map((s) => ({
      actionType: { Normal: s.action },
      childCharacterType: "Pl0000",
      hits: 1,
      minDamage: s.damage ?? 0,
      maxDamage: s.damage ?? 0,
      totalDamage: s.damage ?? 0,
      sbaGenerated: s.sbaGenerated,
      totalStunValue: 0,
      maxStunValue: 0,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
    })),
  }) as unknown as ComputedPlayerState;

const NO_PINS: SelectorPins = { source: null, targets: [], ability: null };

const input = (
  level: "players" | "abilities" | "skills",
  players: ComputedPlayerState[],
  pins: SelectorPins = NO_PINS
) =>
  ({
    encounter: { totalDamage: 0 } as never,
    partyData: [null, null],
    players,
    level,
    pins,
  }) as never;

describe("sba descriptor", () => {
  it("ranks players by the gauge they generated, not the level they ended on", () => {
    // The level is what made every row read 0.0: it is whatever the gauge
    // happened to be at the end, and a player who burst finishes at zero.
    const players = [player(0, { sba: 0, sbaGenerated: 2400 }), player(1, { sba: 950, sbaGenerated: 950 })];

    const rows = sba.rows(input("players", players));
    expect(rows.map((row) => row.key)).toEqual(["player:0", "player:1"]);
    expect(rows[0].value).toBe(2400);
  });

  it("descends into an ability breakdown when a player row without one is pinned", () => {
    // B6: generation now carries a per-ability split (see "sba drill-down"
    // below), so a player with nothing attributed to any skill drills down to
    // an empty table rather than the player rows repeating themselves.
    const players = [player(0, { sba: 0, sbaGenerated: 2400 }), player(1, { sba: 950, sbaGenerated: 950 })];
    expect(sba.rows(input("abilities", players, { source: 0, targets: [], ability: null }))).toEqual([]);
  });

  it("reports the generated total and the current level as separate columns", () => {
    const rows = sba.rows(input("players", [player(0, { sba: 250, sbaGenerated: 1750 })]));
    expect(rows[0].columns).toEqual(["1750", "250"]);
  });

  it("falls back to the level for a log served without the generated total", () => {
    // An older backend sends no sbaGenerated. Ranking every row at 0 would be
    // the defect this replaced; the level is the only figure there is.
    const rows = sba.rows(input("players", [player(0, { sba: 640 })]));
    expect(rows[0].value).toBe(640);
    expect(rows[0].columns).toEqual(["—", "640"]);
  });

  it("does not fall back to the level when the generated total is present but zero", () => {
    // `??` not `||`: a genuine zero total is a real figure, not a missing one.
    const rows = sba.rows(input("players", [player(0, { sba: 250, sbaGenerated: 0 })]));
    expect(rows[0].value).toBe(0);
    expect(rows[0].columns).toEqual(["0", "250"]);
  });
});

describe("sba drill-down", () => {
  // Ungrouped action ids (see damageDone.test.ts): 100/110 on Pl0000 fold into
  // the shipped "normal-attack" group, which would test the grouping logic
  // rather than the SBA split.
  const owner = () =>
    player(0, {
      sba: 0,
      sbaGenerated: 300,
      skillBreakdown: [
        { action: 9001, damage: 0, sbaGenerated: 200 },
        { action: 9002, damage: 0, sbaGenerated: 100 },
      ],
    });

  it("pins a player row so it can be descended into", () => {
    const rows = sba.rows(input("players", [owner()]));
    expect(rows[0].pinOnClick).toEqual({ source: 0 });
  });

  it("lists a pinned player's abilities biggest first", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 0, targets: [], ability: null }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:9001", "skill:Normal:9002"]);
    expect(rows.map((row) => row.value)).toEqual([200, 100]);
  });

  it("reports each ability's generated total and its share", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 0, targets: [], ability: null }));
    expect(rows[0].columns).toEqual(["200", "66.7%"]);
  });

  it("returns nothing for a pinned source with no data", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 99, targets: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("returns nothing when no source is pinned, because a gauge belongs to one player", () => {
    // Unlike damage, an SBA breakdown is never summed across the party — a
    // remote player's own breakdown is always empty (see the "no pin" case
    // below), so widening the scope would only ever add zeros.
    const rows = sba.rows(input("abilities", [owner()], { source: null, targets: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("offers no pin on an ability row, because a gain carries no target to descend into", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 0, targets: [], ability: null }));
    expect(rows.every((row) => row.pinOnClick === null)).toBe(true);
  });

  it("colours every ability row with the pinned player's slot", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 0, targets: [], ability: null }));
    expect(rows.every((row) => row.colorSlot === 0)).toBe(true);
  });

  it("is empty for a remote player's breakdown, honestly", () => {
    // Attribution only works for the local player; a remote member's gauge is
    // synced rather than granted by a hit the hook can see.
    const remote = player(1, { sba: 0, sbaGenerated: 500, skillBreakdown: [] });
    const rows = sba.rows(input("abilities", [remote], { source: 1, targets: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("names the gauge no ability accounts for, so the shares add up", () => {
    // Live log 1681: only 58-69% of a player's generated gauge comes from a
    // damaging hit the hook can caption. The rest is real gauge from perfect
    // dodges, an ally's burst and chain awards — none of which reach the
    // attribution path. Leaving it out made the shares stop short of 100% with
    // nothing saying why.
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 400,
            skillBreakdown: [
              { action: 9001, sbaGenerated: 200 },
              { action: 9002, sbaGenerated: 100 },
            ],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );

    const residue = rows.find((row) => row.key === "skill:unattributed");
    expect(residue).toBeDefined();
    expect(residue?.value).toBe(100);
    expect(residue?.columns).toEqual(["100", "25.0%"]);
    // Named by the table, not by the ability join: there is no ability here.
    expect(residue?.labelKey).toBe("ui.logs.sba-unattributed");
    expect(residue?.pinOnClick).toBeNull();
    expect(residue?.colorSlot).toBe(-1);
  });

  it("ranks the unattributed remainder among the abilities by size", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 1000,
            skillBreakdown: [
              { action: 9001, sbaGenerated: 200 },
              { action: 9002, sbaGenerated: 100 },
            ],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    expect(rows.map((row) => row.key)).toEqual(["skill:unattributed", "skill:Normal:9001", "skill:Normal:9002"]);
  });

  it("adds no remainder row when every gain is accounted for", () => {
    const rows = sba.rows(input("abilities", [owner()], { source: 0, targets: [], ability: null }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:9001", "skill:Normal:9002"]);
  });

  it("adds no remainder row for a sub-unit gap, which would only draw a zero", () => {
    // Gauge units are tenths of a percent and the column rounds to whole ones,
    // so a 0.3 remainder would render as a row reading "0".
    const rows = sba.rows(
      input(
        "abilities",
        [player(0, { sba: 0, sbaGenerated: 300.3, skillBreakdown: [{ action: 9001, sbaGenerated: 300 }] })],
        { source: 0, targets: [], ability: null }
      )
    );
    expect(rows).toHaveLength(1);
  });

  it("adds no remainder row when nothing at all is attributed", () => {
    // A player with no attribution has no split to be the remainder OF, and the
    // table's own empty state explains that case properly.
    const remote = player(1, { sba: 0, sbaGenerated: 500, skillBreakdown: [] });
    const rows = sba.rows(input("abilities", [remote], { source: 1, targets: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("adds no remainder row for a log served without a generated total", () => {
    // No total means no denominator: the gap would be the negative of what IS
    // attributed, which is not a measurement.
    const rows = sba.rows(
      input("abilities", [player(0, { sba: 0, skillBreakdown: [{ action: 9001, sbaGenerated: 200 }] })], {
        source: 0,
        targets: [],
        ability: null,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:Normal:9001");
  });

  it("lists non-skill causes beside the abilities", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 400,
            skillBreakdown: [{ action: 9001, sbaGenerated: 200 }],
            sbaSources: [
              { kind: "partyAward", generated: 150 },
              { kind: "damageTaken", generated: 50 },
            ],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );

    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:9001", "source:partyAward", "source:damageTaken"]);
    const party = rows.find((row) => row.key === "source:partyAward");
    expect(party?.labelKey).toBe("ui.logs.sba-cause-party-award");
    expect(party?.columns).toEqual(["150", "37.5%"]);
    expect(party?.pinOnClick).toBeNull();
  });

  it("names an effect source by its id", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 100,
            skillBreakdown: [{ action: 9001, sbaGenerated: 90 }],
            sbaSources: [{ kind: "effect", id: 4242, generated: 10 }],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    const effect = rows.find((row) => row.key === "source:effect:4242");
    expect(effect?.labelKey).toBe("ui.logs.sba-cause-effect");
    expect(effect?.labelParams).toEqual({ id: "0x1092" });
  });

  it("formats an effect key as hex, because it is a hash, not a count", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 100,
            skillBreakdown: [{ action: 9001, sbaGenerated: 90 }],
            sbaSources: [{ kind: "effect", id: 0x7edd69d0, generated: 10 }],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    const effect = rows.find((row) => row.key === "source:effect:2128439760");
    expect(effect?.labelParams).toEqual({ id: "0x7EDD69D0" });
  });

  it("names a known effect key instead of showing the hash", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 100,
            skillBreakdown: [{ action: 9001, sbaGenerated: 90 }],
            sbaSources: [{ kind: "effect", id: 0xdeadbeef, generated: 10 }],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    const effect = rows.find((row) => row.key === "source:effect:3735928559");
    expect(effect?.labelKey).toBe("ui.logs.sba-effect-test-entry");
    expect(effect?.labelParams).toBeUndefined();
  });

  it("labels a perfect-dodge source", () => {
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 100,
            skillBreakdown: [{ action: 9001, sbaGenerated: 90 }],
            sbaSources: [{ kind: "perfectDodge", generated: 10 }],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    expect(rows.find((row) => row.key === "source:perfectDodge")?.labelKey).toBe("ui.logs.sba-cause-perfect-dodge");
  });

  it("counts sources against the unattributed remainder", () => {
    // The remainder is what NOTHING explains — a named cause is an explanation,
    // so it must shrink the remainder, not sit alongside a remainder that still
    // counts it as missing.
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 400,
            skillBreakdown: [{ action: 9001, sbaGenerated: 200 }],
            sbaSources: [{ kind: "partyAward", generated: 150 }],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    const residue = rows.find((row) => row.key === "skill:unattributed");
    expect(residue?.value).toBe(50);
  });

  it("sums a skill group's gains and drops attribution-less abilities", () => {
    // 100 and 110 both fold into Pl0000's shipped "normal-attack" group; 9001 is
    // ungrouped and carries damage but no attribution (a damage-only entry from
    // a log predating per-skill SBA), so the zero-filter must drop it.
    const rows = sba.rows(
      input(
        "abilities",
        [
          player(0, {
            sba: 0,
            sbaGenerated: 200,
            skillBreakdown: [
              { action: 100, sbaGenerated: 120 },
              { action: 110, sbaGenerated: 80 },
              { action: 9001, damage: 50 },
            ],
          }),
        ],
        { source: 0, targets: [], ability: null }
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(200);
    expect(rows[0].key).toMatch(/normal-attack/);
  });
});

describe("sbaCauseLabel", () => {
  it("names a bare cause from its kind", () => {
    expect(sbaCauseLabel("source:partyAward")).toEqual({
      labelKey: "ui.logs.sba-cause-party-award",
      labelParams: undefined,
    });
  });

  it("prints an unknown effect key as hex, the way every other tool here does", () => {
    expect(sbaCauseLabel("source:effect:48879")).toEqual({
      labelKey: "ui.logs.sba-cause-effect",
      labelParams: { id: "0xBEEF" },
    });
  });

  it("names a KNOWN effect key outright, with no id to print", () => {
    expect(sbaCauseLabel(`source:effect:${0xd2c8e10a}`)).toEqual({
      labelKey: "ui.logs.sba-cause-perfect-dodge",
      labelParams: undefined,
    });
  });

  it("keeps a site tag decimal — small ordinals, not hashes", () => {
    expect(sbaCauseLabel("source:site:3")).toEqual({
      labelKey: "ui.logs.sba-cause-site",
      labelParams: { id: 3 },
    });
  });

  it("falls back to unknown for a cause the UI has not been taught", () => {
    expect(sbaCauseLabel("source:somethingNew")?.labelKey).toBe("ui.logs.sba-cause-unknown");
  });

  it("names the unattributed remainder despite its skill: key", () => {
    // The remainder wears a `skill:` key but has no ability behind it, so it
    // must be recognised BEFORE any skill-naming branch.
    expect(sbaCauseLabel(SBA_UNATTRIBUTED_KEY)).toEqual({ labelKey: "ui.logs.sba-unattributed" });
  });

  it("declines a real skill key, so skill bands keep their own naming", () => {
    expect(sbaCauseLabel("skill:Normal:1")).toBeNull();
  });
});
