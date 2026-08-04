import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, StatusInterval } from "@/types";

import type { RowLevel } from "../deriveRows";
import type { SelectorPins } from "../selectorOptions";

import { buffs, narrowedByPins } from "./buffs";
import { debuffs } from "./debuffs";

const interval = (
  actor: number,
  start: number,
  end: number,
  status = 10,
  ability: number | null = 500,
  stacks = 1,
  applications = 1,
  targetSegment: number | null = null
): StatusInterval => ({
  actorIndex: actor,
  casterIndex: 0,
  statusId: status,
  abilityId: ability,
  startMs: start,
  endMs: end,
  maxStacks: stacks,
  targetSegment,
  applications,
});

// Narmaya (0) has it twice (overlapping), Eugen (1) once, and there is a second
// buff. Actor 9 is an enemy — no player carries that index — and deliberately
// holds a HARMFUL id (1001, Burn): the debuffs suite needs a real debuff, and
// a beneficial id there would silently empty the debuffs table instead of
// testing what it means to.
const INTERVALS: StatusInterval[] = [
  interval(0, 0, 5_000, 10, 500, 3),
  interval(0, 4_000, 8_000, 10, 500, 4),
  interval(1, 0, 2_000, 10, 500, 2),
  interval(0, 0, 1_000, 20, 600),
  interval(9, 0, 6_000, 1001, 700),
];

// Both polarities on both sides, so a test can name any one of the four
// quadrants. burn (1001) is harmful, bloodthirst (32) and protect (10)
// beneficial — per the generated statusPolarity table.
const MIXED_SIDES: StatusInterval[] = [
  interval(0, 0, 4_000, 1001, 500), // Burn ON Narmaya
  interval(0, 0, 2_000, 10, 500), // protect on Narmaya
  interval(9, 0, 6_000, 32, 700, 1, 1, 2), // Bloodthirst, enemy spawn 2's own
  interval(9, 0, 5_000, 1001, 800, 1, 1, 2), // Burn on enemy spawn 2
];

const PLAYERS = [
  { index: 0, partyIndex: 0 },
  { index: 1, partyIndex: 1 },
] as ComputedPlayerState[];

const input = (
  level: RowLevel,
  ability: string | null = null,
  intervals = INTERVALS,
  players = PLAYERS,
  hostility?: "friendly" | "enemy"
) =>
  ({
    statusIntervals: intervals,
    fightDurationMs: 10_000,
    players,
    roster: PLAYERS,
    level,
    // `targets`, spelled as SelectorPins spells it — the helper said `targetIds`,
    // which no reader of the pins has ever looked at.
    pins: { source: null, targets: [], ability },
    hostility,
  }) as never;

describe("buffs descriptor", () => {
  it("gives one row per (effect, cause) when nothing is pinned", () => {
    const rows = buffs.rows(input("players"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(["status:10:500", "status:20:600"]);
  });

  it("leaves enemy-held effects off the friendly Buffs table", () => {
    // Actor 9 is nobody's player index (and Burn is harmful besides) — under
    // the default friendly hostility this table shows neither.
    expect(buffs.rows(input("players")).some((r) => r.key === "status:1001:700")).toBe(false);
  });

  it("merges overlapping intervals when computing a buff's uptime", () => {
    // Narmaya 0-8000 (merged) plus Eugen 0-2000, unioned across actors = 8000.
    expect(buffs.rows(input("players"))[0].value).toBe(8_000);
  });

  it("reports uptime as a share of the fight", () => {
    expect(buffs.rows(input("players"))[0].columns[0]).toBe("80%");
  });

  it("pins the buff into the Ability selector", () => {
    // WCL behaviour: you select the buff, you do not expand it.
    expect(buffs.rows(input("players"))[0].pinOnClick).toEqual({ ability: "status:10:500" });
  });

  it("gives one row per holder when a buff is pinned", () => {
    // The PIN says which effect, not the level — the level comes from a pin
    // shared with the damage tabs and cannot mean both things.
    const rows = buffs.rows(input("skills", "status:10:500"));
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(8_000); // Narmaya, merged
    expect(rows[1].value).toBe(2_000); // Eugen
  });

  it("gives holder rows for a pinned buff at any level", () => {
    // rowLevelFor no longer descends on a status pin, so the level here is
    // whatever the OTHER pins made it. The rows must not depend on that.
    expect(buffs.rows(input("players", "status:10:500")).map((r) => r.key)).toEqual(["player:0", "player:1"]);
    expect(buffs.rows(input("abilities", "status:10:500")).map((r) => r.key)).toEqual(["player:0", "player:1"]);
  });

  it("keeps a buff on the Buffs table when the scoped party has been narrowed", () => {
    // A source pin narrows `players` to one; the roster is what decides a
    // holder's SIDE, so reading it from the scoped party filed the rest of the
    // party's buffs as enemy-held.
    const scoped = [{ index: 0, partyIndex: 0 }] as ComputedPlayerState[];
    const rows = buffs.rows(input("abilities", null, INTERVALS, scoped));
    expect(rows.map((r) => r.key)).toEqual(["status:10:500", "status:20:600"]);
    // Eugen's window still counts toward the effect's uptime.
    expect(rows[0].value).toBe(8_000);
  });

  it("colours a holder row by its party slot", () => {
    expect(buffs.rows(input("skills", "status:10:500"))[1].colorSlot).toBe(1);
  });

  it("makes holder rows leaves", () => {
    expect(buffs.rows(input("skills", "status:10:500")).every((r) => r.pinOnClick === null)).toBe(true);
  });

  it("sums applications across every holder of an effect", () => {
    // Warcraft Logs' Count column: the parent row's count is the sum of its
    // holders' (Power Infusion 4 + 3 + 1 = 8). Narmaya holds two windows of
    // status 10 and Eugen one, so the effect landed three times.
    expect(buffs.rows(input("players"))[0].columns[1]).toBe("3");
  });

  it("counts only a holder's own applications on its row", () => {
    const rows = buffs.rows(input("skills", "status:10:500"));
    expect(rows[0].columns[1]).toBe("2"); // Narmaya: two windows
    expect(rows[1].columns[1]).toBe("1"); // Eugen: one
  });

  it("counts every refresh, not every window", () => {
    // A refresh extends one window rather than opening a second, so the
    // interval's own count is the only record that it happened.
    const refreshed = [interval(0, 0, 5_000, 10, 500, 1, 12)];
    expect(buffs.rows(input("players", null, refreshed))[0].columns[1]).toBe("12");
  });

  it("keeps the effect rows when a damage ability is pinned", () => {
    // Pins are shared across the metric tabs, so arriving from the Damage tab
    // must not empty this one: a non-status pin selects no buff.
    expect(buffs.rows(input("skills", "skill:Normal-1234"))).toHaveLength(2);
  });

  it("returns no rows when there are no intervals", () => {
    expect(buffs.rows(input("players", null, []))).toEqual([]);
  });
});

describe("debuffs descriptor", () => {
  // Every case here is about the ENEMY holders, which is now a side the caller
  // asks for rather than one the tab assumes — see "defaults to the friendly
  // holders, exactly like Buffs" below for the other half.
  const enemySide = (level: RowLevel, ability: string | null = null, intervals = INTERVALS) =>
    input(level, ability, intervals, PLAYERS, "enemy");

  it("defaults to the friendly holders, exactly like Buffs", () => {
    // Polarity and holder side are independent axes. Defaulting this tab to the
    // enemy side made the switch read as a consequence of the tab, and hid the
    // ailments the party was carrying — which is what a Debuffs tab is for.
    // Burn (1001) on Narmaya is the only harmful effect a player holds here.
    expect(debuffs.rows(input("players", null, MIXED_SIDES)).map((r) => r.key)).toEqual(["status:1001:500"]);
  });

  it("gives one row per effect held by a non-player", () => {
    const rows = debuffs.rows(enemySide("players"));
    expect(rows.map((r) => r.key)).toEqual(["status:1001:700"]);
  });

  it("counts an enemy's uptime the same way", () => {
    expect(debuffs.rows(enemySide("players"))[0].value).toBe(6_000);
  });

  it("leaves enemy rows without a party colour", () => {
    expect(debuffs.rows(enemySide("players"))[0].colorSlot).toBe(-1);
  });

  it("gives one holder row per enemy SPAWN, not per recycled actor id", () => {
    // The Four Dragons case end to end: one actor id, two spawns. Keyed on the
    // id the two dragons shared a row labelled with a bare number.
    const recycled = [interval(9, 0, 1_000, 1001, 700, 1, 1, 0), interval(9, 5_000, 9_000, 1001, 700, 1, 1, 1)];
    const rows = debuffs.rows(enemySide("skills", "status:1001:700", recycled));
    expect(rows.map((r) => r.key)).toEqual(["target:1", "target:0"]);
  });

  it("keeps an enemy the segmenter never placed on its own row", () => {
    // A phantom marker actor gets no segment. Its window is real capture, so it
    // keeps a row — labelled by the raw id, which is all that is known.
    const rows = debuffs.rows(enemySide("skills", "status:1001:700", [interval(9, 0, 6_000, 1001, 700)]));
    expect(rows.map((r) => r.key)).toEqual(["actor:9"]);
  });
});

describe("narrowedByPins", () => {
  const pins = (over: Partial<SelectorPins> = {}): SelectorPins => ({
    source: null,
    targets: [],
    ability: null,
    ...over,
  });

  // Two holders, and a debuff on two different enemy spawns cast by two players.
  const HELD = [interval(0, 0, 1_000), interval(1, 0, 1_000)];
  const ON_ENEMIES = [
    { ...interval(9, 0, 1_000, 30, 700, 1, 1, 4), casterIndex: 0 },
    { ...interval(8, 0, 1_000, 30, 700, 1, 1, 5), casterIndex: 1 },
  ];

  it("admits everything when nothing is pinned", () => {
    expect(narrowedByPins(HELD, pins(), "friendly")).toEqual(HELD);
    expect(narrowedByPins(ON_ENEMIES, pins(), "enemy")).toEqual(ON_ENEMIES);
  });

  it("narrows a buff to the pinned HOLDER", () => {
    expect(narrowedByPins(HELD, pins({ source: 1 }), "friendly")).toEqual([HELD[1]]);
  });

  it("ignores an enemy pin on a buff, which has no enemy spawn", () => {
    expect(narrowedByPins(HELD, pins({ targets: [4] }), "friendly")).toEqual(HELD);
  });

  it("narrows a debuff to the pinned CASTER, not its holder", () => {
    expect(narrowedByPins(ON_ENEMIES, pins({ source: 1 }), "enemy")).toEqual([ON_ENEMIES[1]]);
  });

  it("narrows a debuff to the pinned enemy SPAWN", () => {
    expect(narrowedByPins(ON_ENEMIES, pins({ targets: [4] }), "enemy")).toEqual([ON_ENEMIES[0]]);
  });

  it("drops a debuff with no spawn when an enemy is pinned", () => {
    const noSpawn = { ...interval(9, 0, 1_000, 30, 700), casterIndex: 0 };
    expect(narrowedByPins([noSpawn], pins({ targets: [4] }), "enemy")).toEqual([]);
  });

  it("applies caster and spawn together", () => {
    expect(narrowedByPins(ON_ENEMIES, pins({ source: 0, targets: [5] }), "enemy")).toEqual([]);
  });

  it("ignores a STATUS ability pin, which selects the effect rather than an actor", () => {
    expect(narrowedByPins(HELD, pins({ ability: "status:10:500" }), "friendly")).toEqual(HELD);
  });
});

describe("polarity and hostility", () => {
  it("keeps harmful effects off the Buffs table even when a player holds them", () => {
    expect(buffs.rows(input("players", null, MIXED_SIDES)).map((r) => r.key)).toEqual(["status:10:500"]);
  });

  it("keeps enemy self-buffs off the Debuffs table", () => {
    // Bloodthirst is a buff the enemy gave itself — the exact row the
    // holder-based split used to misfile as a debuff.
    expect(debuffs.rows(input("players", null, MIXED_SIDES, PLAYERS, "enemy")).map((r) => r.key)).toEqual([
      "status:1001:800",
    ]);
  });

  it("shows enemy self-buffs on the Buffs table under enemy hostility", () => {
    expect(buffs.rows(input("players", null, MIXED_SIDES, PLAYERS, "enemy")).map((r) => r.key)).toEqual([
      "status:32:700",
    ]);
  });

  it("keys enemy-held holder rows by spawn under enemy hostility", () => {
    const rows = buffs.rows(input("players", "status:32:700", MIXED_SIDES, PLAYERS, "enemy"));
    expect(rows.map((r) => r.key)).toEqual(["target:2"]);
    expect(rows[0].colorSlot).toBe(-1);
  });

  it("shows ailments on players on the Debuffs table under friendly hostility", () => {
    expect(debuffs.rows(input("players", null, MIXED_SIDES, PLAYERS, "friendly")).map((r) => r.key)).toEqual([
      "status:1001:500",
    ]);
  });

  it("keys player-held holder rows by player under friendly hostility", () => {
    const rows = debuffs.rows(input("players", "status:1001:500", MIXED_SIDES, PLAYERS, "friendly"));
    expect(rows.map((r) => r.key)).toEqual(["player:0"]);
    expect(rows[0].colorSlot).toBe(0);
  });

  it("reads one side for both tabs when no hostility is given", () => {
    // The absent-hostility default must not be per-tab: that is exactly the
    // coupling this pair of axes was untangled from.
    const buffKeys = buffs.rows(input("players", null, MIXED_SIDES)).map((r) => r.key);
    const debuffKeys = debuffs.rows(input("players", null, MIXED_SIDES)).map((r) => r.key);
    expect(buffKeys).toEqual(["status:10:500"]);
    expect(debuffKeys).toEqual(["status:1001:500"]);
  });
});
