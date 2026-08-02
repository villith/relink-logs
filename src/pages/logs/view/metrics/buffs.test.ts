import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, StatusInterval } from "@/types";

import type { RowLevel } from "../deriveRows";

import { buffs } from "./buffs";
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
// buff. Actor 9 is an enemy — no player carries that index.
const INTERVALS: StatusInterval[] = [
  interval(0, 0, 5_000, 10, 500, 3),
  interval(0, 4_000, 8_000, 10, 500, 4),
  interval(1, 0, 2_000, 10, 500, 2),
  interval(0, 0, 1_000, 20, 600),
  interval(9, 0, 6_000, 30, 700),
];

const PLAYERS = [
  { index: 0, partyIndex: 0 },
  { index: 1, partyIndex: 1 },
] as ComputedPlayerState[];

const input = (level: RowLevel, ability: string | null = null, intervals = INTERVALS) =>
  ({
    statusIntervals: intervals,
    fightDurationMs: 10_000,
    players: PLAYERS,
    level,
    pins: { source: null, targetIds: [], ability },
  }) as never;

describe("buffs descriptor", () => {
  it("gives one row per (effect, cause) when nothing is pinned", () => {
    const rows = buffs.rows(input("players"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(["status:10:500", "status:20:600"]);
  });

  it("leaves enemy-held effects to the debuffs table", () => {
    // Actor 9 is nobody's player index, so status 30 is not a buff.
    expect(buffs.rows(input("players")).some((r) => r.key === "status:30:700")).toBe(false);
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
    // A pinned ability is the deepest level — see rowLevelFor.
    const rows = buffs.rows(input("skills", "status:10:500"));
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(8_000); // Narmaya, merged
    expect(rows[1].value).toBe(2_000); // Eugen
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
  it("gives one row per effect held by a non-player", () => {
    const rows = debuffs.rows(input("players"));
    expect(rows.map((r) => r.key)).toEqual(["status:30:700"]);
  });

  it("counts an enemy's uptime the same way", () => {
    expect(debuffs.rows(input("players"))[0].value).toBe(6_000);
  });

  it("leaves enemy rows without a party colour", () => {
    expect(debuffs.rows(input("players"))[0].colorSlot).toBe(-1);
  });

  it("gives one holder row per enemy SPAWN, not per recycled actor id", () => {
    // The Four Dragons case end to end: one actor id, two spawns. Keyed on the
    // id the two dragons shared a row labelled with a bare number.
    const recycled = [
      interval(9, 0, 1_000, 30, 700, 1, 1, 0),
      interval(9, 5_000, 9_000, 30, 700, 1, 1, 1),
    ];
    const rows = debuffs.rows(input("skills", "status:30:700", recycled));
    expect(rows.map((r) => r.key)).toEqual(["target:1", "target:0"]);
  });

  it("keeps an enemy the segmenter never placed on its own row", () => {
    // A phantom marker actor gets no segment. Its window is real capture, so it
    // keeps a row — labelled by the raw id, which is all that is known.
    const rows = debuffs.rows(input("skills", "status:30:700", [interval(9, 0, 6_000, 30, 700)]));
    expect(rows.map((r) => r.key)).toEqual(["actor:9"]);
  });
});
