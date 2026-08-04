import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { sba } from "./sba";

const player = (
  index: number,
  values: {
    sba: number;
    sbaGenerated?: number;
    skillBreakdown?: { action: number; damage?: number; sbaGenerated?: number }[];
  }
) =>
  ({
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
