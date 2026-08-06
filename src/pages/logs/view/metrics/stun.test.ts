import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { stun } from "./stun";

const player = (
  index: number,
  total: number,
  perSecond: number,
  skills: { action: number; stun: number; child?: string; max?: number }[]
) =>
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
      childCharacterType: s.child ?? "Pl0000",
      hits: 1,
      minDamage: null,
      maxDamage: null,
      totalDamage: 0,
      totalStunValue: s.stun,
      maxStunValue: s.max ?? s.stun,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
    })),
  }) as unknown as ComputedPlayerState;

const PLAYERS = [
  player(0, 120, 4.5, [
    { action: 9001, stun: 80 },
    { action: 9002, stun: 40 },
  ]),
  player(1, 60, 2.0, []),
];

const NO_PINS: SelectorPins = { source: null, targets: [], ability: null };

const input = (
  level: "players" | "abilities" | "skills",
  pins: SelectorPins = NO_PINS,
  players: ComputedPlayerState[] = PLAYERS
) => ({ encounter: { totalDamage: 0 } as never, partyData: [null, null], players, level, pins }) as never;

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
    const rows = stun.rows(input("abilities", { source: 0, targets: [], ability: null }));
    expect(rows.map((r) => r.value)).toEqual([80, 40]);
  });

  it("returns no rows for a source with no data", () => {
    expect(stun.rows(input("abilities", { source: 99, targets: [], ability: null }))).toEqual([]);
  });

  it("lists a pinned group's member skills at the skills level, unpinnable", () => {
    const owner = [
      player(0, 90, 3.0, [
        { action: 100, stun: 50, max: 30 },
        { action: 110, stun: 40, max: 25 },
      ]),
    ];
    const rows = stun.rows(input("skills", { source: 0, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, owner));

    expect(rows.map((r) => r.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]);
    expect(rows.map((r) => r.value)).toEqual([50, 40]);
    expect(rows.every((r) => r.pinOnClick === null)).toBe(true);
  });

  it("sums every player's breakdown when an ability is pinned with no friendly", () => {
    const party = [
      player(0, 50, 2.0, [{ action: 100, stun: 50, max: 30 }]),
      player(1, 20, 1.0, [{ action: 100, stun: 20, max: 40 }]),
    ];
    const rows = stun.rows(
      input("skills", { source: null, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, party)
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(70);
    // The max is the biggest single hit anyone landed, so it crosses players.
    expect(rows[0].columns[1]).toBe("40.0");
    expect(rows[0].colorSlot).toBe(-1);
  });

  it("sums abilities that share an action id into one row, keeping the largest single hit", () => {
    // Two breakdown rows under one ability — the player's own hits and their
    // summon's. Stun totals add; the max is the biggest single hit either
    // landed, so it takes the larger rather than the sum.
    const withSummon = [
      player(0, 120, 4.5, [
        { action: 9001, stun: 50, max: 30 },
        { action: 9001, stun: 30, max: 25, child: "Wp0000" },
        { action: 9002, stun: 40 },
      ]),
    ];
    const rows = stun.rows(input("abilities", { source: 0, targets: [], ability: null }, withSummon));

    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(80);
    expect(rows[0].columns).toEqual(["80.0", "30.0"]);
  });
});

describe("stun — rows that applied no stun", () => {
  const PINNED: SelectorPins = { source: 0, targets: [], ability: null };

  it("drops ability rows whose skills applied no stun", () => {
    // Most of a rotation is stun-incapable, or lands while the enemy is already
    // stunned. Listing those is a wall of honest zeros — the same rule
    // metrics/sba.ts applies to its attributed rows.
    const roster = [
      player(0, 20, 2, [
        { action: 1, stun: 20 },
        { action: 2, stun: 0 },
      ]),
    ];
    const rows = stun.rows(input("abilities", PINNED, roster));

    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:1"]);
  });

  it("drops them one level down too, where rows are a group's members", () => {
    const roster = [
      player(0, 5, 1, [
        { action: 1, stun: 5 },
        { action: 2, stun: 0 },
      ]),
    ];
    const rows = stun.rows(input("skills", PINNED, roster));

    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:1"]);
  });

  it("keeps a row whose stun is real but rounds to 0.0 in the column", () => {
    // The filter is on the VALUE, not the rendered string: a genuinely tiny
    // accrual is data, and hiding it would under-report the total above it.
    const roster = [player(0, 0.04, 0, [{ action: 1, stun: 0.04 }])];
    const rows = stun.rows(input("abilities", PINNED, roster));

    expect(rows).toHaveLength(1);
    expect(rows[0].columns[0]).toBe("0.0");
  });

  it("still lists players who applied no stun, so the roster stays intact", () => {
    const roster = [player(0, 20, 2, [{ action: 1, stun: 20 }]), player(1, 0, 0, [])];
    const rows = stun.rows(input("players", NO_PINS, roster));

    expect(rows).toHaveLength(2);
  });
});
