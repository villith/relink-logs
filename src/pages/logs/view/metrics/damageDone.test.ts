import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { damageDone } from "./damageDone";

const player = (index: number, total: number, skills: { action: number; damage: number }[]) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: total,
    dps: total / 10,
    percentage: 0,
    sba: 0,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: skills.map((s) => ({
      actionType: { Normal: s.action },
      childCharacterType: "Pl0000",
      hits: 1,
      minDamage: s.damage,
      maxDamage: s.damage,
      totalDamage: s.damage,
      totalStunValue: 0,
      maxStunValue: 0,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
    })),
  }) as unknown as ComputedPlayerState;

const PLAYERS = [
  player(0, 300, [
    { action: 100, damage: 200 },
    { action: 200, damage: 100 },
  ]),
  player(1, 100, []),
];

const NO_PINS: SelectorPins = { source: null, targetIds: [], ability: null };

const input = (level: "players" | "abilities" | "hits", pins: SelectorPins = NO_PINS) =>
  ({
    encounter: { totalDamage: 400 } as never,
    partyData: [null, null],
    players: PLAYERS,
    level,
    pins,
  }) as never;

describe("damageDone descriptor", () => {
  it("gives one row per player at the players level, biggest first", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(300);
    expect(rows[1].value).toBe(100);
  });

  it("makes a player row pin that player as the source", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows[0].pinOnClick).toEqual({ source: 0 });
  });

  it("gives the pinned player's abilities at the abilities level", () => {
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }));
    expect(rows.map((r) => r.value)).toEqual([200, 100]);
    expect(rows[0].pinOnClick).toEqual({ ability: "Normal:100" });
  });

  it("returns no rows when the pinned source has no data", () => {
    const rows = damageDone.rows(input("abilities", { source: 99, targetIds: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("swaps the second column header when it descends a level", () => {
    // The column carries DPS for players and a hit count for abilities, so the
    // header cannot be fixed.
    expect(damageDone.columnKeys("players")).not.toEqual(damageDone.columnKeys("abilities"));
  });
});
