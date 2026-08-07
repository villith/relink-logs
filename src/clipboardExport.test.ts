import { beforeEach, describe, expect, it, vi } from "vitest";

import { MeterColumns, type EncounterState, type PlayerState, type SkillState } from "./types";
import { exportFullEncounterToClipboard, exportSimpleEncounterToClipboard } from "./utils";

/** Characterization coverage for the two clipboard exports, which shared ~35
 * lines of copied body before `encounterCsvPlayers`/`playerCsvRow` pulled them
 * apart. Asserted on the exact text: the exports have no other contract than
 * what lands on the clipboard. */

const skill = (totalDamage: number, hits: number): SkillState =>
  ({
    actionType: { Normal: 100 },
    childCharacterType: "Pl1000",
    hits,
    minDamage: 10,
    maxDamage: 90,
    totalDamage,
    totalStunValue: 0,
    maxStunValue: 0,
  }) as unknown as SkillState;

const player = (index: number, totalDamage: number, dps: number, skills: SkillState[]): PlayerState =>
  ({
    index,
    characterType: "Pl1000",
    totalDamage,
    dps,
    sba: 0,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    skillBreakdown: skills,
  }) as unknown as PlayerState;

const encounter: EncounterState = {
  totalDamage: 3000,
  dps: 30.4,
  startTime: 0,
  endTime: 100_000,
  party: {
    "0": player(0, 1000, 10, [skill(600, 3), skill(400, 2)]),
    "1": player(1, 2000, 20.6, [skill(2000, 5)]),
  },
  status: "InProgress",
  targets: {},
} as unknown as EncounterState;

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("exportSimpleEncounterToClipboard", () => {
  it("writes the summary row and one line per player, biggest first", () => {
    exportSimpleEncounterToClipboard(MeterColumns.TotalDamage, "desc", encounter, [null, null, null, null]);

    expect(writeText).toHaveBeenCalledWith(
      [
        "Encounter Time, Total Damage, Total DPS",
        "01:40, 3000, 30",
        "Name, DMG, DPS, %",
        "[Guest] {character}, 2000, 21, 66.67%",
        "[Guest] {character}, 1000, 10, 33.33%",
      ].join("\n")
    );
  });

  it("honours the sort direction", () => {
    exportSimpleEncounterToClipboard(MeterColumns.TotalDamage, "asc", encounter, [null, null, null, null]);

    const written = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(written.split("\n").slice(3)).toEqual([
      "[Guest] {character}, 1000, 10, 33.33%",
      "[Guest] {character}, 2000, 21, 66.67%",
    ]);
  });

  it("refuses an encounter with no damage", () => {
    exportSimpleEncounterToClipboard(MeterColumns.TotalDamage, "desc", { ...encounter, totalDamage: 0 }, []);

    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("exportFullEncounterToClipboard", () => {
  it("follows each player with their skills, biggest first", () => {
    exportFullEncounterToClipboard(MeterColumns.TotalDamage, "desc", encounter, [null, null, null, null]);

    const written = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(written.split("\n")).toEqual([
      "Encounter Time, Total Damage, Total DPS",
      "01:40, 3000, 30",
      "Name, DMG, DPS, %",
      "[Guest] {character}, 2000, 21, 66.67%",
      "Skill, Hits, Total, Min, Max, Avg, %",
      expect.stringContaining(", 5, 2000, 10, 90, 400, 100.00%"),
      "Name, DMG, DPS, %",
      "[Guest] {character}, 1000, 10, 33.33%",
      "Skill, Hits, Total, Min, Max, Avg, %",
      expect.stringContaining(", 3, 600, 10, 90, 200, 60.00%"),
      expect.stringContaining(", 2, 400, 10, 90, 200, 40.00%"),
    ]);
  });

  it("refuses an encounter with no damage", () => {
    exportFullEncounterToClipboard(MeterColumns.TotalDamage, "desc", { ...encounter, totalDamage: 0 }, []);

    expect(writeText).not.toHaveBeenCalled();
  });
});
