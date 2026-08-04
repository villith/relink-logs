import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { damageTaken, takenAttackNameKey, takenAttackRowParts } from "./damageTaken";

const player = (
  index: number,
  values: {
    totalDamageTaken?: number;
    hitsTaken?: number;
    damageTakenBreakdown?: { enemy: number; action: number; hits: number; total: number; max: number }[];
  }
) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: 0,
    dps: 0,
    percentage: 0,
    sba: 0,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: [],
    totalDamageTaken: values.totalDamageTaken,
    hitsTaken: values.hitsTaken,
    damageTakenBreakdown: (values.damageTakenBreakdown ?? []).map((row) => ({
      enemyType: { Unknown: row.enemy },
      actionId: { Normal: row.action },
      hits: row.hits,
      totalDamage: row.total,
      maxDamage: row.max,
    })),
  }) as unknown as ComputedPlayerState;

const NO_PINS: SelectorPins = { source: null, targets: [], ability: null };

const input = (
  level: "players" | "abilities" | "skills",
  players: ComputedPlayerState[],
  pins: SelectorPins = NO_PINS,
  fightDurationMs = 100_000
) =>
  ({
    encounter: { totalDamage: 0 } as never,
    partyData: [null, null],
    players,
    level,
    pins,
    fightDurationMs,
  }) as never;

describe("damageTaken descriptor", () => {
  it("ranks players by the damage they took, reporting amount and DTPS", () => {
    const players = [
      player(0, { totalDamageTaken: 1_000, hitsTaken: 4 }),
      player(1, { totalDamageTaken: 6_000, hitsTaken: 2 }),
    ];

    // 100s fight → DTPS is amount / 100.
    const rows = damageTaken.rows(input("players", players));

    expect(rows.map((row) => row.key)).toEqual(["player:1", "player:0"]);
    expect(rows[0].value).toBe(6_000);
    expect(rows[0].columns).toEqual(["6.0k", "60"]);
    expect(rows[1].columns).toEqual(["1.0k", "10"]);
  });

  it("reports a log recorded before damage-taken capture as not recorded", () => {
    // An older log carries no taken fields at all; a zero would claim the
    // player was never hit.
    const rows = damageTaken.rows(input("players", [player(0, {})]));

    expect(rows[0].value).toBe(0);
    expect(rows[0].columns).toEqual(["—", "—"]);
  });

  it("descends a pinned player into per-attack rows with hit figures", () => {
    const players = [
      player(0, {
        totalDamageTaken: 900,
        hitsTaken: 4,
        damageTakenBreakdown: [
          { enemy: 0xaa, action: 1, hits: 2, total: 500, max: 400 },
          { enemy: 0xaa, action: 2, hits: 1, total: 300, max: 300 },
          { enemy: 0xbb, action: 9, hits: 1, total: 100, max: 100 },
        ],
      }),
    ];

    const rows = damageTaken.rows(input("abilities", players, { source: 0, targets: [], ability: null }));

    // One row per (attacker, attack) — action ids are per-enemy id spaces, so
    // folding "action 1" across two enemies would merge unrelated attacks.
    expect(rows).toHaveLength(3);
    expect(rows[0].kind).toBe("takenAttack");
    // Amount, hits, average hit, DTPS over the 100s window.
    expect(rows[0].columns).toEqual(["500", "2", "250", "5"]);
    expect(rows[0].value).toBe(500);
    // The label carries both halves for the view to name and illustrate.
    expect(takenAttackRowParts(rows[0].label)).toEqual({
      enemyType: { Unknown: 0xaa },
      actionId: { Normal: 1 },
    });
  });

  it("sums the whole party's attackers when no player is pinned", () => {
    const players = [
      player(0, {
        totalDamageTaken: 500,
        hitsTaken: 1,
        damageTakenBreakdown: [{ enemy: 0xaa, action: 1, hits: 1, total: 500, max: 500 }],
      }),
      player(1, {
        totalDamageTaken: 300,
        hitsTaken: 1,
        damageTakenBreakdown: [{ enemy: 0xaa, action: 1, hits: 1, total: 300, max: 300 }],
      }),
    ];

    const rows = damageTaken.rows(input("abilities", players));

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(800);
    expect(rows[0].columns[1]).toBe("2");
  });

  it("answers a pinned player missing from the scoped party with nothing", () => {
    const rows = damageTaken.rows(
      input("abilities", [player(0, { totalDamageTaken: 1 })], { source: 7, targets: [], ability: null })
    );

    expect(rows).toEqual([]);
  });

  it("round-trips a malformed attack-row label as null rather than throwing", () => {
    expect(takenAttackRowParts("not json")).toBeNull();
  });

  it("names enemy attacks by id, DoT ticks by kind, and anything else generically", () => {
    expect(takenAttackNameKey({ Normal: 9001 })).toEqual({
      key: "ui.logs.taken-attack",
      params: { id: 9001 },
    });
    expect(takenAttackNameKey({ DamageOverTime: 1 })).toEqual({ key: "ui.logs.taken-dot" });
    expect(takenAttackNameKey("LinkAttack")).toEqual({ key: "ui.logs.taken-attack-other" });
  });
});
