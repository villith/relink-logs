import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import { sba } from "./sba";

const player = (index: number, sbaValue: number) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: 0,
    dps: 0,
    percentage: 0,
    sba: sbaValue,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: [],
  }) as unknown as ComputedPlayerState;

const PLAYERS = [player(0, 2.5), player(1, 4.0)];

const input = (level: "players" | "abilities" | "hits") =>
  ({
    encounter: { totalDamage: 0 } as never,
    partyData: [null, null],
    players: PLAYERS,
    level,
    pins: { source: null, targetIds: [], ability: null },
  }) as never;

describe("sba descriptor", () => {
  it("ranks players by gauge value", () => {
    expect(sba.rows(input("players")).map((r) => r.value)).toEqual([4, 2.5]);
  });

  it("stays player rows even when a level below is requested", () => {
    // A gauge belongs to a player, not a skill — there is no level to descend to.
    expect(sba.rows(input("abilities")).map((r) => r.value)).toEqual([4, 2.5]);
  });

  it("makes rows unclickable", () => {
    expect(sba.rows(input("players")).every((r) => r.pinOnClick === null)).toBe(true);
  });
});
