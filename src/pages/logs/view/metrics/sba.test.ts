import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import { sba } from "./sba";

const player = (index: number, values: { sba: number; sbaGenerated?: number }) =>
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
    skillBreakdown: [],
  }) as unknown as ComputedPlayerState;

const input = (level: "players" | "abilities" | "skills", players: ComputedPlayerState[]) =>
  ({
    encounter: { totalDamage: 0 } as never,
    partyData: [null, null],
    players,
    level,
    pins: { source: null, targets: [], ability: null },
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
});
