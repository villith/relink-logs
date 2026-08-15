import type { LogSummary } from "@/types";

import { chainKey } from "../../repeatChains";

/** One entry of the picker's list: a Repeat Quest chain with its runs, or a
 * lone log as a chain of one. The chain header is a LABEL, not an option — a
 * chain is not a thing you can open, only its runs are. */
export type LogPickerGroup = {
  /** The chain's shared id (`repeatGroup ?? id`), unique per group. */
  key: number;
  isChain: boolean;
  questId: number | null;
  questName: string;
  runs: LogSummary[];
  /** The best in-game time anyone in the chain set, or null when nothing in it
   * reported one. Null rather than 0, which would read as a clear nobody ran. */
  bestQuestElapsedTime: number | null;
};

/** Whether one log answers the picker's search box.
 *
 * Matches the translated quest name, the character ids in the party and the raw
 * log id, so `zegagrande`, `pl1400` and `2657` all land. The date is matched by
 * the caller, which owns the locale. */
export const logMatchesQuery = (log: LogSummary, query: string, questName: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [questName, String(log.id), log.p1Type ?? "", log.p2Type ?? "", log.p3Type ?? "", log.p4Type ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
};

/** The picker's list: logs grouped by repeat chain, filtered by the search box,
 * in the order the library gave them (newest first).
 *
 * Grouped by chain key rather than by adjacency — unlike the quest list, whose
 * `groupRepeatChains` merges only CONSECUTIVE rows to avoid visually reordering
 * a user-sorted table, this list has one fixed order and a chain's members must
 * gather even when a search leaves them apart. `chainKey` is shared with that
 * one on purpose: the rule for what belongs to a chain has one author.
 *
 * A group survives only if at least one of its runs matches; the runs shown are
 * the matching ones, so searching a character does not offer runs they sat out. */
export const logPickerGroups = (
  logs: LogSummary[],
  query: string,
  questNameOf: (questId: number | null) => string
): LogPickerGroup[] => {
  const groups = new Map<number, LogPickerGroup>();

  for (const log of logs) {
    const questName = questNameOf(log.questId);
    if (!logMatchesQuery(log, query, questName)) continue;

    const key = chainKey(log);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        isChain: false,
        questId: log.questId,
        questName,
        runs: [log],
        bestQuestElapsedTime: log.questElapsedTime,
      });
      continue;
    }
    existing.runs.push(log);
    // A group is a chain once a SECOND run joins it, so a chain whose other
    // runs the search filtered out correctly reads as a single run.
    existing.isChain = true;
    if (
      log.questElapsedTime !== null &&
      (existing.bestQuestElapsedTime === null || log.questElapsedTime < existing.bestQuestElapsedTime)
    ) {
      existing.bestQuestElapsedTime = log.questElapsedTime;
    }
  }

  return [...groups.values()];
};
