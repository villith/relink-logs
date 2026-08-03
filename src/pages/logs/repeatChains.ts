/** Grouping of Repeat Quest chains for the quest list.
 *
 * The backend stamps every later run of a chain with `repeatGroup` = the id of
 * the chain's first run (the first run itself carries null). The list shows a
 * chain collapsed under one visible row.
 */

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
