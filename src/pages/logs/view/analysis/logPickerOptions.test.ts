import { describe, expect, it } from "vitest";

import type { LogSummary } from "@/types";

import { epochToLocalTime } from "@/utils";

import {
  NO_QUEST,
  capPickerGroups,
  formatRunSpan,
  logMatchesFilters,
  logPickerGroups,
  pickerFacets,
} from "./logPickerOptions";

const log = (over: Partial<LogSummary> & { id: number }): LogSummary => ({
  time: 1_700_000_000,
  duration: 120_000,
  questId: 2657,
  questElapsedTime: 180,
  p1Name: "Rain",
  p1Type: "Pl1400",
  p2Name: null,
  p2Type: null,
  p3Name: null,
  p3Type: null,
  p4Name: null,
  p4Type: null,
  repeatGroup: null,
  ...over,
});

/** No narrowing at all — what the picker opens on. */
const ALL = { questId: null, characters: [], players: [] };
/** The picker's resting order, and the library's: newest first. */
const NEWEST_FIRST = { key: "time", direction: "desc" } as const;

describe("logMatchesFilters", () => {
  const subject = log({ id: 1, questId: 2657, p1Type: "Pl1400", p1Name: "Rain", p2Type: "Pl0700", p2Name: "Kahs" });

  it("admits every log when nothing is narrowed", () => {
    expect(logMatchesFilters(subject, ALL)).toBe(true);
  });

  it("keeps a log of the picked quest", () => {
    expect(logMatchesFilters(subject, { ...ALL, questId: 2657 })).toBe(true);
  });

  it("drops a log of another quest", () => {
    expect(logMatchesFilters(subject, { ...ALL, questId: 2619 })).toBe(false);
  });

  // A log with no quest id at all — a Conflux run, or one recorded before the
  // id was stored — is a pickable thing, so it needs a value the filter can
  // name. `null` already means "no filter", hence a sentinel.
  it("picks out the logs carrying no quest id", () => {
    expect(logMatchesFilters(log({ id: 2, questId: null }), { ...ALL, questId: NO_QUEST })).toBe(true);
    expect(logMatchesFilters(subject, { ...ALL, questId: NO_QUEST })).toBe(false);
  });

  it("keeps a log whose party holds the picked character", () => {
    expect(logMatchesFilters(subject, { ...ALL, characters: ["Pl0700"] })).toBe(true);
  });

  // AND, not OR: two characters picked means the run they were BOTH in, which
  // is the question a comparison is usually asking.
  it("wants every picked character in the one party", () => {
    expect(logMatchesFilters(subject, { ...ALL, characters: ["Pl1400", "Pl0700"] })).toBe(true);
    expect(logMatchesFilters(subject, { ...ALL, characters: ["Pl1400", "Pl2000"] })).toBe(false);
  });

  it("keeps a log whose party holds the picked player", () => {
    expect(logMatchesFilters(subject, { ...ALL, players: ["Kahs"] })).toBe(true);
  });

  it("wants every picked player in the one party", () => {
    expect(logMatchesFilters(subject, { ...ALL, players: ["Rain", "Kahs"] })).toBe(true);
    expect(logMatchesFilters(subject, { ...ALL, players: ["Rain", "Eustace"] })).toBe(false);
  });

  it("applies the three narrowings together", () => {
    expect(logMatchesFilters(subject, { questId: 2657, characters: ["Pl1400"], players: ["Kahs"] })).toBe(true);
    expect(logMatchesFilters(subject, { questId: 2619, characters: ["Pl1400"], players: ["Kahs"] })).toBe(false);
  });
});

describe("pickerFacets", () => {
  it("offers each quest in the library once", () => {
    const facets = pickerFacets([log({ id: 1, questId: 2657 }), log({ id: 2, questId: 2657 }), log({ id: 3 })]);
    expect(facets.questIds).toEqual([2657]);
  });

  // Same shape as the player list: a few quests run over and over, and a tail
  // run once. Sorted by name, the one you want sits wherever its initial falls.
  it("offers the most-run quests first", () => {
    const facets = pickerFacets([
      log({ id: 1, questId: 2619 }),
      log({ id: 2, questId: 2657 }),
      log({ id: 3, questId: 2657 }),
      log({ id: 4, questId: 2622 }),
      log({ id: 5, questId: 2657 }),
      log({ id: 6, questId: 2619 }),
    ]);
    expect(facets.questIds).toEqual([2657, 2619, 2622]);
  });

  // A tie keeps the library's own order, which is newest first — so of two
  // quests run as often, the recent one leads.
  it("leaves quests the count cannot separate in library order", () => {
    const facets = pickerFacets([log({ id: 1, questId: 2622 }), log({ id: 2, questId: 2619 })]);
    expect(facets.questIds).toEqual([2622, 2619]);
  });

  // Only when there is something to pick: an entry for logs with no quest, in a
  // library where every log has one, is a filter that can only empty the list.
  it("offers the no-quest entry only when such a log exists", () => {
    expect(pickerFacets([log({ id: 1 })]).questIds).not.toContain(NO_QUEST);
    expect(pickerFacets([log({ id: 1, questId: null })]).questIds).toContain(NO_QUEST);
  });

  it("offers every character anyone played", () => {
    const facets = pickerFacets([
      log({ id: 1, p1Type: "Pl1400", p2Type: "Pl0700" }),
      log({ id: 2, p1Type: "Pl0700", p2Type: "Pl2000" }),
    ]);
    expect([...facets.characters].sort()).toEqual(["Pl0700", "Pl1400", "Pl2000"]);
  });

  it("offers every player who was named, and no empty slot", () => {
    const facets = pickerFacets([
      log({ id: 1, p1Name: "Rain", p2Name: null, p3Name: "Kahs" }),
      log({ id: 2, p1Name: "Rain" }),
    ]);
    expect([...facets.players].sort()).toEqual(["Kahs", "Rain"]);
  });

  // The library's real shape is a few regulars and a long tail of people met
  // once, so the people you actually run with come first. Alphabetical put
  // whoever starts with an A at the top of that tail.
  it("offers the players run with most often first", () => {
    const facets = pickerFacets([
      log({ id: 1, p1Name: "Abel", p2Name: "Rain" }),
      log({ id: 2, p1Name: "Rain", p2Name: "Kahs" }),
      log({ id: 3, p1Name: "Rain" }),
      log({ id: 4, p1Name: "Kahs" }),
    ]);
    expect(facets.players).toEqual(["Rain", "Kahs", "Abel"]);
  });

  // One run together is one run, whichever slots it was played from — a name in
  // two slots of one party would otherwise count double.
  it("counts a log once for a player who filled two of its slots", () => {
    const facets = pickerFacets([
      log({ id: 1, p1Name: "Rain", p2Name: "Rain" }),
      log({ id: 2, p1Name: "Kahs" }),
      log({ id: 3, p1Name: "Kahs" }),
    ]);
    expect(facets.players).toEqual(["Kahs", "Rain"]);
  });
});

describe("logPickerGroups", () => {
  it("leaves an unchained log as its own single-run group", () => {
    const groups = logPickerGroups([log({ id: 1 })], ALL, NEWEST_FIRST);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual([1]);
    expect(groups[0].isChain).toBe(false);
  });

  it("collects a repeat chain under one group header", () => {
    const groups = logPickerGroups(
      [log({ id: 10 }), log({ id: 11, repeatGroup: 10 }), log({ id: 12, repeatGroup: 10 })],
      ALL,
      NEWEST_FIRST
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].isChain).toBe(true);
    expect(groups[0].runs.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  // The header states what the chain came to rather than how many runs it
  // holds — a count is something the rows under it already show.
  it("reports the chain's best wall-clock duration on its header", () => {
    const groups = logPickerGroups(
      [log({ id: 10, duration: 400_000 }), log({ id: 11, repeatGroup: 10, duration: 300_000 })],
      ALL,
      NEWEST_FIRST
    );
    expect(groups[0].bestDurationMs).toBe(300_000);
  });

  // Where the chain STARTED and where it ended, taken across the runs rather
  // than off the ends of the list: the sort decides which run leads, and under
  // a duration sort that is not the earliest one.
  it("reports the span the chain was run over", () => {
    const groups = logPickerGroups(
      [
        log({ id: 10, time: 300, duration: 100 }),
        log({ id: 11, repeatGroup: 10, time: 100, duration: 900 }),
        log({ id: 12, repeatGroup: 10, time: 200, duration: 500 }),
      ],
      ALL,
      { key: "duration", direction: "asc" }
    );
    expect([groups[0].firstTime, groups[0].lastTime]).toEqual([100, 300]);
  });

  // Which run set each best, so the header's figure can be tinted on the row
  // it came from rather than leaving the reader to match two equal times.
  it("names the runs that set each best", () => {
    const groups = logPickerGroups(
      [
        log({ id: 10, duration: 400_000, questElapsedTime: 200 }),
        log({ id: 11, repeatGroup: 10, duration: 300_000, questElapsedTime: 300 }),
      ],
      ALL,
      NEWEST_FIRST
    );
    expect(groups[0].bestDurationId).toBe(11);
    expect(groups[0].bestQuestElapsedId).toBe(10);
  });

  it("reports the best in-game time on its header", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: 184 }), log({ id: 11, repeatGroup: 10, questElapsedTime: 161 })],
      ALL,
      NEWEST_FIRST
    );
    expect(groups[0].bestQuestElapsedMs).toBe(161_000);
  });

  // Null rather than 0: a chain nobody finished has no best time, and 0 would
  // draw as a clear in no time at all.
  it("has no best time when nothing in the chain reported one", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: null }), log({ id: 11, repeatGroup: 10, questElapsedTime: null })],
      ALL,
      NEWEST_FIRST
    );
    expect(groups[0].bestQuestElapsedMs).toBeNull();
  });

  // The placeholder the quest timer stored before it was read correctly. The
  // list draws anything under two seconds as "-", and so must this.
  it("does not take the 1s placeholder as a chain's best time", () => {
    const groups = logPickerGroups(
      [log({ id: 10, questElapsedTime: 1 }), log({ id: 11, repeatGroup: 10, questElapsedTime: 161 })],
      ALL,
      NEWEST_FIRST
    );
    expect(groups[0].bestQuestElapsedMs).toBe(161_000);
  });

  it("colours a chain so it reads as one block, and leaves a lone run uncoloured", () => {
    const groups = logPickerGroups([log({ id: 10 }), log({ id: 11, repeatGroup: 10 }), log({ id: 20 })], ALL, {
      key: "time",
      direction: "asc",
    });
    expect(groups[0].color).toBeTruthy();
    expect(groups[1].color).toBeUndefined();
  });

  it("drops a group whose every run fails the filters", () => {
    const groups = logPickerGroups(
      [log({ id: 1 }), log({ id: 2, questId: 9999 })],
      { ...ALL, questId: 9999 },
      NEWEST_FIRST
    );
    expect(groups.flatMap((group) => group.runs).map((r) => r.id)).toEqual([2]);
  });

  // Filtering a character offers only the runs they were in, even when their
  // chain-mates share the header.
  it("keeps a surviving group down to its matching runs", () => {
    const groups = logPickerGroups(
      [log({ id: 10 }), log({ id: 11, repeatGroup: 10, p1Type: "Pl0700" })],
      { ...ALL, characters: ["Pl0700"] },
      NEWEST_FIRST
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual([11]);
    expect(groups[0].isChain).toBe(false);
  });

  describe("ordering, which mirrors the quest list's", () => {
    it("opens newest first", () => {
      const groups = logPickerGroups(
        [log({ id: 1, time: 100 }), log({ id: 3, time: 300 }), log({ id: 2, time: 200 })],
        ALL,
        NEWEST_FIRST
      );
      expect(groups.map((group) => group.runs[0].id)).toEqual([3, 2, 1]);
    });

    it("sorts by wall-clock duration", () => {
      const groups = logPickerGroups(
        [log({ id: 1, duration: 300 }), log({ id: 2, duration: 100 }), log({ id: 3, duration: 200 })],
        ALL,
        { key: "duration", direction: "asc" }
      );
      expect(groups.map((group) => group.runs[0].id)).toEqual([2, 3, 1]);
    });

    it("sorts by in-game time", () => {
      const groups = logPickerGroups(
        [log({ id: 1, questElapsedTime: 300 }), log({ id: 2, questElapsedTime: 100 })],
        ALL,
        { key: "quest-elapsed-time", direction: "asc" }
      );
      expect(groups.map((group) => group.runs[0].id)).toEqual([2, 1]);
    });

    // Nothing to rank by sorts LAST in either direction: a run the list draws
    // as "-" answers neither "fastest" nor "slowest".
    it("puts the logs with no in-game time last, whichever way it reads", () => {
      const logs = [log({ id: 1, questElapsedTime: null }), log({ id: 2, questElapsedTime: 100 })];
      const ids = (direction: "asc" | "desc") =>
        logPickerGroups(logs, ALL, { key: "quest-elapsed-time", direction }).map((group) => group.runs[0].id);

      expect(ids("asc")).toEqual([2, 1]);
      expect(ids("desc")).toEqual([2, 1]);
    });

    it("treats the 1s placeholder as no in-game time at all", () => {
      const groups = logPickerGroups(
        [log({ id: 1, questElapsedTime: 1 }), log({ id: 2, questElapsedTime: 500 })],
        ALL,
        { key: "quest-elapsed-time", direction: "asc" }
      );
      expect(groups.map((group) => group.runs[0].id)).toEqual([2, 1]);
    });

    // The list's placement rule: the run the sort would put first is the one
    // the chain stands on — its MIN ascending, its MAX descending.
    it("places a chain by its fastest run when fastest reads first", () => {
      const groups = logPickerGroups(
        [
          log({ id: 1, questElapsedTime: 300 }),
          log({ id: 3, repeatGroup: 1, questElapsedTime: 100 }),
          log({ id: 2, questElapsedTime: 200 }),
        ],
        ALL,
        { key: "quest-elapsed-time", direction: "asc" }
      );
      expect(groups.flatMap((group) => group.runs).map((run) => run.id)).toEqual([3, 1, 2]);
    });

    it("places a chain by its slowest run when slowest reads first", () => {
      const groups = logPickerGroups(
        [
          log({ id: 1, questElapsedTime: 300 }),
          log({ id: 3, repeatGroup: 1, questElapsedTime: 100 }),
          log({ id: 2, questElapsedTime: 400 }),
        ],
        ALL,
        { key: "quest-elapsed-time", direction: "desc" }
      );
      expect(groups.flatMap((group) => group.runs).map((run) => run.id)).toEqual([2, 1, 3]);
    });

    // Date is the exception: the summary states the chain's most recent run, so
    // the block sits where that visible date belongs.
    it("places a chain by its latest run under a date sort, either way", () => {
      const logs = [log({ id: 1, time: 100 }), log({ id: 3, repeatGroup: 1, time: 500 }), log({ id: 2, time: 300 })];
      const order = (direction: "asc" | "desc") =>
        logPickerGroups(logs, ALL, { key: "time", direction })
          .flatMap((group) => group.runs)
          .map((run) => run.id);

      // The chain stands on its latest run (500) either way; only where that
      // places it, and how its own runs read, follow the direction.
      expect(order("asc")).toEqual([2, 1, 3]);
      expect(order("desc")).toEqual([3, 1, 2]);
    });

    it("keeps a chain's runs together when another log sorts between them", () => {
      const groups = logPickerGroups(
        [log({ id: 1, time: 100 }), log({ id: 3, repeatGroup: 1, time: 300 }), log({ id: 2, time: 200 })],
        ALL,
        NEWEST_FIRST
      );
      expect(groups.flatMap((group) => group.runs).map((run) => run.id)).toEqual([3, 1, 2]);
    });

    it("orders the runs inside a chain by the sort too", () => {
      const groups = logPickerGroups(
        [
          log({ id: 1, questElapsedTime: 300 }),
          log({ id: 2, repeatGroup: 1, questElapsedTime: 100 }),
          log({ id: 3, repeatGroup: 1, questElapsedTime: 200 }),
        ],
        ALL,
        { key: "quest-elapsed-time", direction: "asc" }
      );
      expect(groups[0].runs.map((run) => run.id)).toEqual([2, 3, 1]);
    });
  });
});

describe("formatRunSpan", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("states both ends in full when the runs fall on different days", () => {
    const first = at("2026-08-14T13:25:00");
    const last = at("2026-08-15T13:40:00");

    expect(formatRunSpan(first, last)).toBe(`${epochToLocalTime(first)} - ${epochToLocalTime(last)}`);
  });

  // The date is the same fact twice, and the pair is read as one stretch of an
  // afternoon rather than as two timestamps that happen to be adjacent.
  it("names the day once when both runs fall on it", () => {
    const first = at("2026-08-15T13:25:00");
    const last = at("2026-08-15T13:40:00");
    const day = epochToLocalTime(first).split(",")[0];

    const span = formatRunSpan(first, last);

    expect(span.startsWith(epochToLocalTime(first))).toBe(true);
    // Exactly once: `split` on a needle found N times yields N + 1 parts.
    expect(span.split(day)).toHaveLength(2);
  });

  it("separates the two ends with a hyphen", () => {
    const span = formatRunSpan(at("2026-08-15T13:25:00"), at("2026-08-15T13:40:00"));

    expect(span).toContain(" - ");
    expect(span).not.toContain("→");
  });
});

describe("capPickerGroups", () => {
  /** `count` single-run groups, newest first, as the picker gets them. */
  const singles = (count: number) =>
    logPickerGroups(
      Array.from({ length: count }, (_, i) => log({ id: i + 1, time: 1000 - i })),
      ALL,
      NEWEST_FIRST
    );

  it("draws the whole list when it fits under the cap", () => {
    const { groups, hiddenRuns } = capPickerGroups(singles(3), null, 10);
    expect(groups).toHaveLength(3);
    expect(hiddenRuns).toBe(0);
  });

  it("stops at the cap and counts what it left", () => {
    const { groups, hiddenRuns } = capPickerGroups(singles(10), null, 4);
    expect(groups.map((group) => group.runs[0].id)).toEqual([1, 2, 3, 4]);
    expect(hiddenRuns).toBe(6);
  });

  // A chain's header states its run count and its best time, so half a chain
  // would head two options with "chain of 5".
  it("draws a chain whole rather than cutting one at the cap", () => {
    const chain = logPickerGroups(
      [
        log({ id: 1, time: 400 }),
        log({ id: 2, time: 300 }),
        log({ id: 3, repeatGroup: 2, time: 200 }),
        log({ id: 4, repeatGroup: 2, time: 100 }),
      ],
      ALL,
      NEWEST_FIRST
    );

    const { groups, hiddenRuns } = capPickerGroups(chain, null, 2);

    expect(groups).toHaveLength(2);
    expect(groups[1].runs.map((run) => run.id)).toEqual([2, 3, 4]);
    expect(hiddenRuns).toBe(0);
  });

  // A cap smaller than the first chain still has to draw it: an empty dropdown
  // is worse than one that overshoots once.
  it("always draws the first group, however long its chain", () => {
    const chain = logPickerGroups(
      [log({ id: 1, time: 300 }), log({ id: 2, repeatGroup: 1, time: 200 }), log({ id: 3, time: 100 })],
      ALL,
      NEWEST_FIRST
    );

    const { groups, hiddenRuns } = capPickerGroups(chain, null, 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((run) => run.id)).toEqual([1, 2]);
    expect(hiddenRuns).toBe(1);
  });

  it("counts every run behind the cap, not every group", () => {
    const chains = logPickerGroups(
      [
        log({ id: 1, time: 500 }),
        log({ id: 2, time: 400 }),
        log({ id: 3, repeatGroup: 2, time: 300 }),
        log({ id: 4, time: 200 }),
        log({ id: 5, repeatGroup: 4, time: 100 }),
      ],
      ALL,
      NEWEST_FIRST
    );

    expect(capPickerGroups(chains, null, 1).hiddenRuns).toBe(4);
  });

  // The selected log is the one thing the dropdown must be able to scroll to,
  // so the cap cannot be what hides it — its whole group is kept, in place.
  it("keeps the selected log's group even from beyond the cap", () => {
    const { groups, hiddenRuns } = capPickerGroups(singles(10), 9, 4);

    expect(groups.map((group) => group.runs[0].id)).toEqual([1, 2, 3, 4, 9]);
    // Still counted as hidden: the runs the cap left out are what the footer is
    // about, and the rescued group is not one of them.
    expect(hiddenRuns).toBe(5);
  });

  it("does not draw a selected group twice when it already fits", () => {
    const { groups } = capPickerGroups(singles(10), 2, 4);
    expect(groups.map((group) => group.runs[0].id)).toEqual([1, 2, 3, 4]);
  });

  it("rescues the whole chain the selected run belongs to", () => {
    const chains = logPickerGroups(
      [
        log({ id: 1, time: 500 }),
        log({ id: 2, time: 400 }),
        log({ id: 8, time: 300, repeatGroup: 9 }),
        log({ id: 9, time: 200 }),
      ],
      ALL,
      NEWEST_FIRST
    );

    const { groups } = capPickerGroups(chains, 8, 1);

    expect(groups).toHaveLength(2);
    expect(groups[1].runs.map((run) => run.id)).toEqual([8, 9]);
  });
});
