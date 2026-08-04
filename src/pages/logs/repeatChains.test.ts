import { describe, expect, it } from "vitest";

import { PLAYER_COLORS } from "@/utils";

import { chainColors, chainKey, chainLatestTime, groupRepeatChains, summarizeChain } from "./repeatChains";

type Row = { id: number; repeatGroup?: number | null };

const row = (id: number, repeatGroup: number | null = null): Row => ({ id, repeatGroup });

describe("groupRepeatChains", () => {
  it("passes unchained logs through as single-row groups", () => {
    const groups = groupRepeatChains([row(3), row(2), row(1)]);

    expect(groups.map((g) => g.leader.id)).toEqual([3, 2, 1]);
    expect(groups.every((g) => g.rest.length === 0)).toBe(true);
  });

  it("collapses a chain under its first row in display order", () => {
    // Default sort is newest-first, so the parent (oldest run, id 7) comes
    // last and a newer run leads the group.
    const groups = groupRepeatChains([row(9, 7), row(8, 7), row(7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(9);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8, 7]);
  });

  it("groups a chain in ascending order too", () => {
    const groups = groupRepeatChains([row(7), row(8, 7), row(9, 7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(7);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8, 9]);
  });

  it("groups chain rows even when the parent row is not on the page", () => {
    const groups = groupRepeatChains([row(9, 7), row(8, 7)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].leader.id).toBe(9);
    expect(groups[0].rest.map((r) => r.id)).toEqual([8]);
  });

  it("only groups consecutive rows, so a foreign sort order degrades gracefully", () => {
    // Sorted by e.g. duration, an unrelated row can sit inside the chain;
    // merging across it would visually reorder the list.
    const groups = groupRepeatChains([row(9, 7), row(5), row(8, 7)]);

    expect(groups.map((g) => g.leader.id)).toEqual([9, 5, 8]);
    expect(groups.every((g) => g.rest.length === 0)).toBe(true);
  });

  it("keeps two different chains apart", () => {
    const groups = groupRepeatChains([row(9, 7), row(7), row(4, 2), row(2)]);

    expect(groups.map((g) => g.leader.id)).toEqual([9, 4]);
    expect(groups[0].rest.map((r) => r.id)).toEqual([7]);
    expect(groups[1].rest.map((r) => r.id)).toEqual([2]);
  });
});

describe("summarizeChain", () => {
  const run = (id: number, duration: number, questElapsedTime: number | null = null) => ({
    id,
    duration,
    questElapsedTime,
  });

  it("reports the fastest run's times", () => {
    const summary = summarizeChain([run(1, 120_000, 100), run(2, 60_000, 50), run(3, 90_000, 75)]);

    expect(summary.bestDurationMs).toBe(60_000);
    // Seconds on the log, milliseconds out.
    expect(summary.bestQuestElapsedMs).toBe(50_000);
  });

  it("takes each best from its own run", () => {
    // Run 3 ended fastest on the clock, run 2 cleared fastest in game time, so
    // the two figures come from different rows.
    const summary = summarizeChain([run(1, 120_000, 100), run(2, 90_000, 50), run(3, 60_000, 75)]);

    expect(summary.bestDurationMs).toBe(60_000);
    expect(summary.bestQuestElapsedMs).toBe(50_000);
  });

  it("names the run that set each best", () => {
    // Different runs: run 3 ended fastest on the clock, run 2 cleared fastest
    // in game time.
    const summary = summarizeChain([run(1, 120_000, 100), run(2, 90_000, 50), run(3, 60_000, 75)]);

    expect(summary.bestDurationId).toBe(3);
    expect(summary.bestQuestElapsedId).toBe(2);
  });

  it("gives a tie to the first run in display order", () => {
    const summary = summarizeChain([run(1, 60_000, 50), run(2, 60_000, 50)]);

    expect(summary.bestDurationId).toBe(1);
    expect(summary.bestQuestElapsedId).toBe(1);
  });

  it("never reports a placeholder in-game time as the best", () => {
    // 1s is what logs recorded before the timer was read correctly stored; it
    // is not a run's time, so it cannot win "best" — reported, it would claim a
    // record nobody ran.
    const summary = summarizeChain([run(1, 60_000, 100), run(2, 60_000, 1), run(3, 60_000, 200)]);

    expect(summary.bestQuestElapsedMs).toBe(100_000);
    expect(summary.bestQuestElapsedId).toBe(1);
  });

  it("reports no in-game time when no run recorded one", () => {
    const summary = summarizeChain([run(1, 60_000, null), run(2, 30_000, 1)]);

    expect(summary.bestQuestElapsedMs).toBeNull();
    expect(summary.bestQuestElapsedId).toBeNull();
    // Wall-clock duration is always present, so it still summarizes.
    expect(summary.bestDurationMs).toBe(30_000);
    expect(summary.bestDurationId).toBe(2);
  });
});

describe("chainLatestTime", () => {
  it("takes the most recent run whatever order the rows arrive in", () => {
    // Under a duration sort the newest run can sit anywhere in the block, so
    // reading the head of the list would date the chain by the wrong run.
    expect(chainLatestTime([{ time: 200 }, { time: 300 }, { time: 100 }])).toBe(300);
  });

  it("is null with no runs to date", () => {
    expect(chainLatestTime([])).toBeNull();
  });
});

describe("chainKey", () => {
  it("is the parent id for chained rows and the own id otherwise", () => {
    expect(chainKey(row(9, 7))).toBe(7);
    expect(chainKey(row(7))).toBe(7);
    expect(chainKey(row(5, null))).toBe(5);
  });
});

describe("chainColors", () => {
  it("colours only the chains, and gives neighbouring ones different hues", () => {
    // A lone log between two chains: it takes no colour, and — the point of
    // counting positions over chains rather than groups — it does not advance
    // the palette either, so the two chains still differ.
    const groups = groupRepeatChains([row(9, 7), row(7), row(5), row(4, 2), row(2)]);
    const colors = chainColors(groups);

    expect(colors.get(5)).toBeUndefined();
    expect(colors.get(7)).toBe(PLAYER_COLORS[0]);
    expect(colors.get(2)).toBe(PLAYER_COLORS[1]);
  });

  it("wraps back to the start once the palette runs out", () => {
    // One chain per palette slot, plus one more.
    const rows = Array.from({ length: PLAYER_COLORS.length + 1 }, (_, chain) => [
      row(chain * 2 + 2, chain * 2 + 1),
      row(chain * 2 + 1),
    ]).flat();
    const colors = chainColors(groupRepeatChains(rows));

    expect(colors.size).toBe(PLAYER_COLORS.length + 1);
    expect(colors.get(1)).toBe(PLAYER_COLORS[0]);
    expect(colors.get(PLAYER_COLORS.length * 2 + 1)).toBe(PLAYER_COLORS[0]);
  });
});
