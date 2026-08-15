import { describe, expect, it } from "vitest";

import type { LogSummary } from "@/types";

import { logMatchesQuery, logPickerGroups } from "./logPickerOptions";

const log = (over: Partial<LogSummary> & { id: number }): LogSummary => ({
  time: 1_700_000_000,
  duration: 120_000,
  questId: 2657,
  questElapsedTime: 180,
  p1Type: "Pl1400",
  p2Type: null,
  p3Type: null,
  p4Type: null,
  repeatGroup: null,
  ...over,
});

const questName = (id: number | null) => (id === 2657 ? "Zegagrande Cliffs" : "Mock Trial");

describe("logPickerGroups", () => {
  it("leaves an unchained log as its own single-run group", () => {
    const groups = logPickerGroups([log({ id: 1 })], "", questName);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual([1]);
    expect(groups[0].isChain).toBe(false);
  });

  it("collects a repeat chain under one group header", () => {
    const groups = logPickerGroups(
      [log({ id: 10 }), log({ id: 11, repeatGroup: 10 }), log({ id: 12, repeatGroup: 10 })],
      "",
      questName
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].isChain).toBe(true);
    expect(groups[0].runs.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it("reports the chain's best in-game time on its header", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: 184 }), log({ id: 11, repeatGroup: 10, questElapsedTime: 161 })],
      "",
      questName
    );
    expect(groups[0].bestQuestElapsedTime).toBe(161);
  });

  // Null rather than 0: a chain nobody finished has no best time, and 0 would
  // draw as a clear in no time at all.
  it("has no best time when nothing in the chain reported one", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: null }), log({ id: 11, repeatGroup: 10, questElapsedTime: null })],
      "",
      questName
    );
    expect(groups[0].bestQuestElapsedTime).toBeNull();
  });

  it("takes a later run's time when the chain's first run reported none", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: null }), log({ id: 11, repeatGroup: 10, questElapsedTime: 161 })],
      "",
      questName
    );
    expect(groups[0].bestQuestElapsedTime).toBe(161);
  });

  it("keeps a chain whose members are separated in the list", () => {
    const groups = logPickerGroups(
      [log({ id: 10 }), log({ id: 99, questId: 9999 }), log({ id: 11, repeatGroup: 10 })],
      "",
      questName
    );
    const chain = groups.find((group) => group.isChain);
    expect(chain?.runs.map((r) => r.id)).toEqual([10, 11]);
  });

  it("lists the groups in library order, newest first", () => {
    const groups = logPickerGroups([log({ id: 3 }), log({ id: 2 }), log({ id: 1 })], "", questName);
    expect(groups.map((group) => group.key)).toEqual([3, 2, 1]);
  });

  it("drops a group whose every run fails the search", () => {
    const groups = logPickerGroups([log({ id: 1 }), log({ id: 2, questId: 9999 })], "zegagrande", questName);
    expect(groups.flatMap((group) => group.runs).map((r) => r.id)).toEqual([1]);
  });

  // Searching a character offers only the runs they were in, even when their
  // chain-mates share the header.
  it("keeps a surviving group down to its matching runs", () => {
    const groups = logPickerGroups(
      [log({ id: 10 }), log({ id: 11, repeatGroup: 10, p1Type: "Pl0700" })],
      "pl0700",
      questName
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual([11]);
    expect(groups[0].isChain).toBe(false);
  });
});

describe("logMatchesQuery", () => {
  const subject = log({ id: 2657, p1Type: "Pl1400" });

  it("matches the raw log id, which is how a bug report names a log", () => {
    expect(logMatchesQuery(subject, "2657", "Zegagrande Cliffs")).toBe(true);
  });

  it("matches the translated quest name, case-insensitively", () => {
    expect(logMatchesQuery(subject, "ZEGAGRANDE", "Zegagrande Cliffs")).toBe(true);
  });

  it("matches a character in the party", () => {
    expect(logMatchesQuery(subject, "pl1400", "Zegagrande Cliffs")).toBe(true);
  });

  it("admits everything on an empty query", () => {
    expect(logMatchesQuery(subject, "", "Zegagrande Cliffs")).toBe(true);
  });

  it("admits everything on a query of nothing but spaces", () => {
    expect(logMatchesQuery(subject, "   ", "Zegagrande Cliffs")).toBe(true);
  });

  it("rejects a term that appears nowhere", () => {
    expect(logMatchesQuery(subject, "wilinus", "Zegagrande Cliffs")).toBe(false);
  });
});
