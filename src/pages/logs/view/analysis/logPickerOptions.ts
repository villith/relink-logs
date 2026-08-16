import type { LogSortType, LogSummary, SortDirection } from "@/types";
import { epochToLocalTime, hasQuestElapsedTime } from "@/utils";

import { chainColors, chainKey, chainLatestTime, groupRepeatChains, summarizeChain } from "../../repeatChains";

/** The quest filter's stand-in for "recorded no quest id" — a Conflux run, or a
 * log from before the id was stored. Those are pickable logs and so need a
 * value the filter can name; `null` already means "every quest". */
export const NO_QUEST = -1;

/** What the picker has been narrowed to. Every field narrows independently, and
 * the two lists narrow by AND: two characters picked means the run they were
 * BOTH in, which is the question a comparison is usually asking. */
export type PickerFilters = {
  questId: number | null;
  characters: string[];
  players: string[];
};

/** Which column the list reads and which way — the quest list's own sort, and
 * deliberately its exact shape (see `orderedGroups`). */
export type PickerSort = { key: LogSortType; direction: SortDirection };

/** One entry of the picker's list: a Repeat Quest chain with its runs, or a
 * lone log as a chain of one. The chain header is a LABEL, not an option — a
 * chain is not a thing you can open, only its runs are. */
export type LogPickerGroup = {
  /** The chain's shared id (`repeatGroup ?? id`), unique per group. */
  key: number;
  isChain: boolean;
  runs: LogSummary[];
  /** The best in-game time anyone in the chain set, in MILLISECONDS, or null
   * when nothing in it reported one. Null rather than 0, which would read as a
   * clear nobody ran. */
  bestQuestElapsedMs: number | null;
  /** The best wall-clock run in the chain, in milliseconds. Always present —
   * every log has a duration, however it ended. */
  bestDurationMs: number;
  /** When the chain's earliest and latest runs happened. Taken ACROSS the runs
   * rather than off the ends of the list, which the sort has reordered. */
  firstTime: number;
  lastTime: number;
  /** Which run set each best, so the row it came from can be marked rather than
   * leaving the reader to match two equal times across the block. Null where
   * nothing in the chain reported one. */
  bestDurationId: number | null;
  bestQuestElapsedId: number | null;
  /** The chain's own colour, so a block of runs reads as one thing. Undefined
   * for a lone run, which is not a block. */
  color?: string;
};

const partyTypes = (log: LogSummary) => [log.p1Type, log.p2Type, log.p3Type, log.p4Type];
const partyNames = (log: LogSummary) => [log.p1Name, log.p2Name, log.p3Name, log.p4Name];

/** Whether one log survives the picker's filters. */
export const logMatchesFilters = (log: LogSummary, filters: PickerFilters): boolean => {
  if (filters.questId !== null) {
    const wanted = filters.questId === NO_QUEST ? null : filters.questId;
    if (log.questId !== wanted) return false;
  }

  const types = partyTypes(log);
  if (!filters.characters.every((character) => types.includes(character))) return false;

  const names = partyNames(log);
  return filters.players.every((player) => names.includes(player));
};

/** What the filters can be narrowed TO: only the quests, characters and players
 * the library actually holds.
 *
 * Derived from the whole library rather than from the current narrowing, so the
 * dropdowns hold still while they are being operated — a facet list that shrank
 * to what the other filters left would take away the option you just picked.
 *
 * Quests and players come back by how OFTEN they appear, most first — both
 * lists are long, and both have the same shape: a few things done over and
 * over, and a tail done once. What you are looking for is nearly always in the
 * first handful.
 *
 * Ties keep the order the library handed them over in, which is newest first,
 * so of two quests run the same number of times the recent one leads. That is
 * also why quest ties are NOT broken by name: a quest's name comes from
 * i18next, and this module would be sorting by an id.
 *
 * Characters stay in first-seen order, and are sorted by their translated name
 * where they are drawn (`LogPicker`), for the same reason: the name is not
 * this module's to resolve. */
export type PickerFacets = { questIds: number[]; characters: string[]; players: string[] };

/** The facets of nothing, hoisted so a picker that has not been opened yet
 * hands its option memos ONE identity rather than a fresh empty every render. */
export const EMPTY_FACETS: PickerFacets = { questIds: [], characters: [], players: [] };

/** Likewise for the group list. */
export const EMPTY_GROUPS: LogPickerGroup[] = [];

export const pickerFacets = (logs: LogSummary[]): PickerFacets => {
  const quests = new Map<number, number>();
  const characters: string[] = [];
  const seenCharacters = new Set<string>();
  const players = new Map<string, number>();

  for (const log of logs) {
    const questId = log.questId ?? NO_QUEST;
    quests.set(questId, (quests.get(questId) ?? 0) + 1);
    for (const type of partyTypes(log)) {
      if (type === null || seenCharacters.has(type)) continue;
      seenCharacters.add(type);
      characters.push(type);
    }
    // One log counts ONCE for a player, whatever they were playing: the figure
    // this orders by is "runs we did together", and a name that took two slots
    // of one party is still one run.
    for (const name of new Set(partyNames(log))) {
      // An empty slot and an AI companion both carry no name; neither is a
      // person you could have played with.
      if (name) players.set(name, (players.get(name) ?? 0) + 1);
    }
  }

  return {
    // Stable sorts, both: entries the count cannot separate keep the order they
    // went in, which is the library's own.
    questIds: [...quests.entries()].sort(([, runsA], [, runsB]) => runsB - runsA).map(([id]) => id),
    characters,
    players: [...players.entries()]
      .sort(([nameA, runsA], [nameB, runsB]) => runsB - runsA || nameA.localeCompare(nameB))
      .map(([name]) => name),
  };
};

/** The value a sort reads off one log, with the values that are not really
 * values folded to null so they sort as the absences they are.
 *
 * Only in-game time has any: taken at face value the stored 1s placeholder is
 * the fastest clear in the library, so "fastest first" would open on a page of
 * runs the row draws as "-". The mirror of `sort_value_expr` in `db/logs.rs`. */
const sortValueOf = (log: LogSummary, key: LogSortType): number | null => {
  switch (key) {
    case "time":
      return log.time;
    case "duration":
      return log.duration;
    case "quest-elapsed-time":
      return hasQuestElapsedTime(log.questElapsedTime) ? (log.questElapsedTime as number) : null;
  }
};

/** Compare two sort values, nulls LAST in either direction: nothing to rank by
 * answers neither "fastest" nor "slowest". */
const compareValues = (a: number | null, b: number | null, direction: SortDirection): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction === "asc" ? a - b : b - a;
};

const extreme = (values: (number | null)[], take: "min" | "max"): number | null =>
  values.reduce<number | null>((best, value) => {
    if (value === null) return best;
    if (best === null) return value;
    return (take === "min" ? value < best : value > best) ? value : best;
  }, null);

/** Where a chain sits in the list.
 *
 * The run the sort would put first is the one the chain stands on: its MIN
 * ascending, its MAX descending. Taking the minimum either way would rank a
 * chain by its best run in a list asking which took longest.
 *
 * Date is the exception, and always the latest run: it is the one column whose
 * summary shows a single run's value rather than a figure about the set — the
 * chain's most recent date — so placing the block anywhere else would put a
 * visible date out of order against the rows around it. */
const placementOf = (runs: LogSummary[], { key, direction }: PickerSort): number | null => {
  const values = runs.map((run) => sortValueOf(run, key));
  return extreme(values, key === "time" || direction === "desc" ? "max" : "min");
};

/** The picker's list: the logs that survive the filters, grouped by repeat
 * chain and ordered by the sort.
 *
 * The ordering is the quest list's, rule for rule — chains placed by the run
 * they stand on, runs inside a chain ordered by the same column, ties broken by
 * the latest run, and chains kept contiguous (see `get_logs`). The list gets
 * that from SQL and a re-sort; here the whole library is already in hand, so it
 * is spelled out. `chainKey`, `summarizeChain` and `chainColors` are shared with
 * it on purpose: what a chain IS has one author.
 *
 * A group survives only if at least one of its runs matches; the runs shown are
 * the matching ones, so filtering to a character does not offer runs they sat
 * out. */
export const logPickerGroups = (logs: LogSummary[], filters: PickerFilters, sort: PickerSort): LogPickerGroup[] => {
  const matching = logs.filter((log) => logMatchesFilters(log, filters));

  const chains = new Map<number, LogSummary[]>();
  for (const log of matching) {
    const key = chainKey(log);
    const runs = chains.get(key);
    if (runs === undefined) chains.set(key, [log]);
    else runs.push(log);
  }

  const ordered = [...chains.values()]
    .map((runs) => ({
      // A stable sort, so runs the column cannot separate keep library order.
      runs: [...runs].sort((a, b) => compareValues(sortValueOf(a, sort.key), sortValueOf(b, sort.key), sort.direction)),
      placement: placementOf(runs, sort),
      // Chains the sort column cannot separate — every untimed chain, and any
      // genuine tie — fall back to the list's resting order, so they hold still
      // instead of arriving in whatever order the grouping happened to produce.
      // Through the quest list's own reader, so what a chain's latest run IS has
      // one author here as well.
      latest: chainLatestTime(runs) ?? 0,
    }))
    .sort(
      (a, b) =>
        compareValues(a.placement, b.placement, sort.direction) || compareValues(a.latest, b.latest, sort.direction)
    );

  // Colours through the quest list's own cycler, which counts CHAINS only, so
  // the lone runs between them do not advance the palette.
  const groups = groupRepeatChains(ordered.flatMap((chain) => chain.runs));
  const colors = chainColors(groups);

  return groups.map(({ leader, rest }) => {
    const runs = [leader, ...rest];
    const color = colors.get(chainKey(leader));
    const times = runs.map((run) => run.time);
    // Through the quest list's own summariser, so "best" means one thing on
    // both pages — including which run gets to claim it on a tie.
    const { bestQuestElapsedMs, bestDurationMs, bestDurationId, bestQuestElapsedId } = summarizeChain(runs);
    return {
      key: chainKey(leader),
      // A group is a chain once a SECOND run joins it, so a chain whose other
      // runs the filters excluded correctly reads as a single run.
      isChain: runs.length > 1,
      runs,
      bestQuestElapsedMs,
      bestDurationMs,
      bestDurationId,
      bestQuestElapsedId,
      firstTime: Math.min(...times),
      lastTime: Math.max(...times),
      ...(color === undefined ? {} : { color }),
    };
  });
};

/** The clock alone, for the far end of a span whose day has already been named. */
const timeOfDay = (epoch: number): string =>
  new Intl.DateTimeFormat("default", { hour: "numeric", minute: "numeric" }).format(new Date(epoch));

/** When a chain was run, as one reading: `8/15/2026, 1:25 PM - 1:40 PM`.
 *
 * The day is named ONCE where both ends fall on it, which is the usual case —
 * a repeat chain is normally one sitting, and printing the same date twice
 * makes a pair of timestamps out of what is really one afternoon. Across a day
 * boundary both ends are stated in full, since then the dates are the point.
 *
 * `epochToLocalTime` owns the locale, so the leading end is formatted through
 * it rather than through a second format declared here. */
export const formatRunSpan = (firstEpoch: number, lastEpoch: number): string => {
  const first = new Date(firstEpoch);
  const last = new Date(lastEpoch);
  const sameDay =
    first.getFullYear() === last.getFullYear() &&
    first.getMonth() === last.getMonth() &&
    first.getDate() === last.getDate();

  return `${epochToLocalTime(firstEpoch)} - ${sameDay ? timeOfDay(lastEpoch) : epochToLocalTime(lastEpoch)}`;
};

/** How many runs the dropdown draws before it stops and says how many it left.
 *
 * A RENDERING budget, not a limit on what the picker can open: the filters
 * above reach everything behind it. It has to exist because the library is
 * every log ever recorded — 1,881 on the machine this was measured on — and
 * Mantine's `Combobox` keeps its options MOUNTED whether or not the dropdown is
 * open. Uncapped, one picker put 17,708 nodes and 7,528 `<img>`s into the page
 * and re-rendered all of them on every keystroke: 616ms to mount, 284ms per
 * character typed, twice over while comparing. */
export const PICKER_RENDER_CAP = 100;

export type LogPickerList = {
  /** The groups the dropdown draws. */
  groups: LogPickerGroup[];
  /** Runs the cap left out. The picker states this rather than trailing off —
   * a list that silently stops looks like a library that ends there. */
  hiddenRuns: number;
};

/** The list the dropdown actually draws: whole groups until the cap is met,
 * plus the group holding `selectedId` wherever it fell.
 *
 * Whole GROUPS, because a chain's header states its run count and its best time
 * (see `picker-chain-best`) — cutting one in half would head two options
 * with "chain of 5". The first group is always drawn however long its chain is,
 * since a cap that renders nothing is worse than one that overshoots once.
 *
 * The selected group is rescued because the dropdown SCROLLS to it on open, and
 * a cap that dropped it would leave that with nothing to find — the one log the
 * reader is certain to look for is the one they are already on. A rescued group
 * does not count as hidden: the footer says what is not on screen, and this
 * group is. */
export const capPickerGroups = (
  groups: LogPickerGroup[],
  selectedId: number | null,
  cap: number = PICKER_RENDER_CAP
): LogPickerList => {
  const shown: LogPickerGroup[] = [];
  let drawn = 0;
  let hiddenRuns = 0;

  for (const group of groups) {
    if (shown.length > 0 && drawn >= cap) {
      // Kept in list order rather than pushed to the end: where the selected
      // log sits among the others is part of what the position says.
      if (selectedId !== null && group.runs.some((run) => run.id === selectedId)) shown.push(group);
      else hiddenRuns += group.runs.length;
      continue;
    }
    shown.push(group);
    drawn += group.runs.length;
  }

  return { groups: shown, hiddenRuns };
};
