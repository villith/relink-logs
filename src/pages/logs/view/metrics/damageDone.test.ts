import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { damageDone } from "./damageDone";

const player = (
  index: number,
  total: number,
  skills: { action: number; damage: number; child?: string; hits?: number; min?: number | null; max?: number | null }[]
) =>
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
      childCharacterType: s.child ?? "Pl0000",
      hits: s.hits ?? 1,
      minDamage: s.min === undefined ? s.damage : s.min,
      maxDamage: s.max === undefined ? s.damage : s.max,
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

const input = (
  level: "players" | "abilities" | "hits",
  pins: SelectorPins = NO_PINS,
  players: ComputedPlayerState[] = PLAYERS
) =>
  ({
    encounter: { totalDamage: 400 } as never,
    partyData: [null, null],
    players,
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

  it("tags each player row with its party slot", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows.map((r) => r.colorSlot)).toEqual([0, 1]);
  });

  it("tags every ability row with the pinned player's slot", () => {
    // All of one player's abilities are that player's colour — the rows are a
    // breakdown of one bar, not four.
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }));
    expect(rows.every((r) => r.colorSlot === 0)).toBe(true);
  });

  it("sums abilities that share an action id into one row", () => {
    // skill_breakdown is keyed by (action, child character type), so a player
    // and their summon using one action id are two rows sharing an abilityKey.
    // Mapping them 1:1 drew the ability twice with its damage split, and handed
    // React two children with the same key. Same defect 68e148c fixed in the
    // hover card.
    const withSummon = [
      player(0, 300, [
        { action: 100, damage: 120, hits: 3 },
        { action: 100, damage: 80, child: "Wp0000", hits: 2 },
        { action: 200, damage: 100 },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }, withSummon));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows[0].value).toBe(200);
    // Hits sum too, or the row reports one contributor's count against both
    // contributors' damage.
    expect(rows[0].columns[1]).toBe("5");
  });

  it("condenses a character's skills into groups, like the classic view does", () => {
    // Against the REAL shipped table: Gran's 100/110/120 are "normal-attack"
    // and 200/201 are "power-raise". Listing every raw action is what made the
    // ability list 27 rows deep where Classic shows a handful.
    const owner = [
      player(0, 300, [
        { action: 100, damage: 30 },
        { action: 110, damage: 20 },
        { action: 120, damage: 10 },
        { action: 200, damage: 40 },
        { action: 201, damage: 5 },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }, owner));

    expect(rows).toHaveLength(2);
    // Biggest first: normal-attack's 60 over power-raise's 45.
    expect(rows[0].value).toBe(60);
    expect(rows[1].value).toBe(45);
    // Pinning a group row pins the group, not one of its members.
    expect(rows[0].pinOnClick).toEqual({ ability: 'Group:normal-attack@"Pl0000"' });
  });

  it("carries min, max and average per ability", () => {
    // These used to sit in the hover card as a fourth "share of a maximum" list,
    // which meant nothing. A column header gives them their meaning back.
    const owner = [player(0, 300, [{ action: 100, damage: 1000, hits: 4, min: 100, max: 500 }])];
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }, owner));

    expect(damageDone.columnKeys("abilities")).toEqual([
      "ui.skill-columns.total",
      "ui.skill-columns.hits",
      "ui.skill-columns.min",
      "ui.skill-columns.max",
      "ui.skill-columns.average",
      "ui.logs.column-share",
    ]);
    expect(rows[0].columns).toEqual(["1.0k", "4", "100", "500", "250", "333.3%"]);
  });

  it("takes the extremes across every skill behind one ability", () => {
    const owner = [
      player(0, 300, [
        { action: 100, damage: 200, hits: 2, min: 80, max: 120 },
        { action: 100, damage: 300, hits: 2, min: 40, max: 260, child: "Wp0000" },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }, owner));

    // Smallest and largest single hit either landed — not the smallest minimum
    // of one contributor alone.
    expect(rows[0].columns.slice(2, 5)).toEqual(["40", "260", "125"]);
  });

  it("shows a dash rather than a zero when a log predates the min/max fields", () => {
    const owner = [player(0, 300, [{ action: 100, damage: 200, hits: 2, min: null, max: null }])];
    const rows = damageDone.rows(input("abilities", { source: 0, targetIds: [], ability: null }, owner));

    // A null is "not recorded", and rendering it as 0 claims a hit landed for
    // nothing. The average is still derivable from total and hits.
    expect(rows[0].columns.slice(2, 5)).toEqual(["—", "—", "100"]);
  });

  it("lists a pinned group's member skills at the skills level", () => {
    // The scoped fetch has already narrowed the party to the pinned group's
    // member actions, so these ARE its members: 100/110/120 are all
    // "normal-attack" in the shipped table, and this level is what shows that.
    const owner = [
      player(0, 60, [
        { action: 100, damage: 30 },
        { action: 110, damage: 20 },
        { action: 120, damage: 10 },
      ]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: 0, targetIds: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows.map((r) => r.key)).toEqual(["skill:Normal:100", "skill:Normal:110", "skill:Normal:120"]);
    expect(rows.map((r) => r.value)).toEqual([30, 20, 10]);
  });

  it("offers no pin at the skills level", () => {
    // Display only: there is nothing below a member skill to descend into.
    const owner = [player(0, 30, [{ action: 100, damage: 30 }])];
    const rows = damageDone.rows(
      input("skills", { source: 0, targetIds: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows.every((r) => r.pinOnClick === null)).toBe(true);
  });

  it("shows one row for a pinned ungrouped ability", () => {
    // Link Attack and SBA never group. One row, itself, is the honest answer.
    const owner = [player(0, 40, [{ action: 9001, damage: 40 }])];
    const rows = damageDone.rows(input("skills", { source: 0, targetIds: [], ability: "Normal:9001" }, owner));

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:Normal:9001");
  });

  it("merges a member dealt by a player and their summon into one row", () => {
    const owner = [
      player(0, 50, [
        { action: 100, damage: 30, hits: 2 },
        { action: 100, damage: 20, hits: 1, child: "Wp0000" },
      ]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: 0, targetIds: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(50);
    expect(rows[0].columns[1]).toBe("3");
  });

  it("carries the share of the level's total as its last column", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows[0].columns.at(-1)).toBe("75.0%");
    expect(rows[1].columns.at(-1)).toBe("25.0%");
  });
});
