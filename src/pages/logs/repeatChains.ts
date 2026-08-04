/** Grouping of Repeat Quest chains for the quest list.
 *
 * The backend stamps every later run of a chain with `repeatGroup` = the id of
 * the chain's first run (the first run itself carries null). The list draws a
 * chain as a summary row with its runs listed beneath it.
 */

import { PLAYER_COLORS, hasQuestElapsedTime } from "@/utils";

type ChainRow = { id: number; repeatGroup?: number | null };

/** One visible row of the quest list: the group's first log in display order,
 * plus the rest of its chain (empty for a normal, unchained log). */
export type RepeatChainGroup<T extends ChainRow> = { leader: T; rest: T[] };

/** The id every member of a chain shares: the parent's own id. */
export function chainKey(log: ChainRow): number {
  return log.repeatGroup ?? log.id;
}

/** Collapse CONSECUTIVE rows of the same chain into one group, preserving row
 * order. Consecutive-only on purpose: under the default newest-first sort a
 * chain is contiguous, while under a foreign sort (duration, IGT) its members
 * scatter and merging across unrelated rows would visually reorder the list.
 * A chain whose parent fell on another page still groups — members share the
 * parent id as key whether or not the parent row itself is present. */
export function groupRepeatChains<T extends ChainRow>(logs: T[]): RepeatChainGroup<T>[] {
  const groups: RepeatChainGroup<T>[] = [];
  for (const log of logs) {
    const current = groups[groups.length - 1];
    // Two distinct unchained logs never collide: their keys are their own
    // unique ids, so equal keys always means "same chain".
    if (current && chainKey(current.leader) === chainKey(log)) {
      current.rest.push(log);
    } else {
      groups.push({ leader: log, rest: [] });
    }
  }
  return groups;
}

/** A run, as the chain summary reads it. `questElapsedTime` is in SECONDS, the
 * shape the log carries. */
type TimedRow = { id: number; duration: number; questElapsedTime?: number | null };

/** What the chain's summary row reports about the runs under it.
 *
 * The best, in every time column. A time on the band has to be a time somebody
 * ran: a total or an average is a figure no row under it holds, and closed —
 * where the band is the only thing on screen — it sits in the same column as
 * the standalone runs around it, inviting a comparison it cannot honestly
 * answer. The best is also what the list places a chain by, so the figure
 * shown and the reason the block sits where it does are one and the same.
 *
 * The in-game times are nullable as a pair: logs recorded before the quest
 * timer was read correctly (and fights the game never reported one for) store
 * a placeholder that `hasQuestElapsedTime` rejects, and a chain of only those
 * has no in-game time to report. Wall-clock duration is always present.
 */
export type ChainSummary = {
  bestDurationMs: number;
  bestQuestElapsedMs: number | null;
  /** The run that set each best, so opening the chain shows WHERE the band's
   * figure came from rather than leaving the reader to match two equal times
   * across the block. Ties go to the first in display order — marking two rows
   * as "the" best says neither. */
  bestDurationId: number | null;
  bestQuestElapsedId: number | null;
};

export function summarizeChain(runs: TimedRow[]): ChainSummary {
  // Seconds on the log, milliseconds everywhere the summary is read.
  const timed = runs.filter((run) => hasQuestElapsedTime(run.questElapsedTime));

  const fastest = <T>(rows: T[], of: (row: T) => number): T | null =>
    rows.reduce<T | null>((best, row) => (best === null || of(row) < of(best) ? row : best), null);

  const bestDuration = fastest(runs, (run) => run.duration);
  const bestElapsed = fastest(timed, (run) => run.questElapsedTime as number);

  return {
    bestDurationMs: bestDuration?.duration ?? 0,
    // Null, not zero: a chain where nothing reported an in-game time has no
    // best, and 00:00 would read as a clear nobody could have run.
    bestQuestElapsedMs: bestElapsed === null ? null : (bestElapsed.questElapsedTime as number) * 1000,
    bestDurationId: bestDuration?.id ?? null,
    bestQuestElapsedId: bestElapsed?.id ?? null,
  };
}

/** When the chain's most recent run happened.
 *
 * Taken as the maximum rather than off the head of the list: the rows arrive in
 * whatever order the user sorted them, and only under the default newest-first
 * is the leading row the latest one. */
export function chainLatestTime(runs: { time: number }[]): number | null {
  return runs.length === 0 ? null : Math.max(...runs.map((run) => run.time));
}

/** A colour per chain, cycled through the party palette — two chains of the
 * same quest, back to back, are otherwise told apart only by where one block of
 * identical rows stops and the next begins.
 *
 * Positions are counted over CHAINS, so the unchained logs between them do not
 * advance the palette: letting them would make the sequence look arbitrary and
 * could land neighbouring chains on the same hue. The same categorical rule
 * `statusRowColors` follows next door, kept here so it is testable rather than
 * buried in the page component.
 *
 * The palette is shared with player rows for its hues alone — no chain means a
 * player, and the meter's per-player colour overrides do not reach here. */
export function chainColors<T extends ChainRow>(groups: RepeatChainGroup<T>[]): Map<number, string> {
  const colors = new Map<number, string>();
  let position = 0;
  for (const group of groups) {
    if (group.rest.length === 0) continue;
    colors.set(chainKey(group.leader), PLAYER_COLORS[position % PLAYER_COLORS.length]);
    position += 1;
  }
  return colors;
}
