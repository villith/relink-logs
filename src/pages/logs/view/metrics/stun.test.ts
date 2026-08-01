import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { stun } from "./stun";

const player = (index: number, total: number, perSecond: number, skills: { action: number; stun: number }[]) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: 0,
    dps: 0,
    percentage: 0,
    sba: 0,
    totalStunValue: total,
    stunPerSecond: perSecond,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: skills.map((s) => ({
      actionType: { Normal: s.action },
      childCharacterType: "Pl0000",
      hits: 1,
      minDamage: null,
      maxDamage: null,
      totalDamage: 0,
      totalStunValue: s.stun,
      maxStunValue: s.stun,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
    })),
  }) as unknown as ComputedPlayerState;

const PLAYERS = [
  player(0, 120, 4.5, [
    { action: 100, stun: 80 },
    { action: 200, stun: 40 },
  ]),
  player(1, 60, 2.0, []),
];

const NO_PINS: SelectorPins = { source: null, targetIds: [], ability: null };

const input = (level: "players" | "abilities" | "hits", pins: SelectorPins = NO_PINS) =>
  ({ encounter: { totalDamage: 0 } as never, partyData: [null, null], players: PLAYERS, level, pins }) as never;

describe("stun descriptor", () => {
  it("ranks players by stun, not by damage", () => {
    // Both players deal zero damage here — ordering must come from stun alone.
    const rows = stun.rows(input("players"));
    expect(rows.map((r) => r.value)).toEqual([120, 60]);
  });

  it("pins the player as the source", () => {
    expect(stun.rows(input("players"))[0].pinOnClick).toEqual({ source: 0 });
  });

  it("breaks a pinned player down by stun-dealing ability", () => {
    const rows = stun.rows(input("abilities", { source: 0, targetIds: [], ability: null }));
    expect(rows.map((r) => r.value)).toEqual([80, 40]);
  });

  it("returns no rows for a source with no data", () => {
    expect(stun.rows(input("abilities", { source: 99, targetIds: [], ability: null }))).toEqual([]);
  });
});
