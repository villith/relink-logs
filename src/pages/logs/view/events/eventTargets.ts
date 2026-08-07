import type { TargetEntry } from "@/types";

import type { ActorSpace } from "./eventRows";

/** The spawn one event's target index names, as an index into `targetEntries`,
 * or -1 for none.
 *
 * Matched in the space the row declares (see `ActorSpace`) — the whole point of
 * carrying one. `spawn` reads `TargetEntry.id`, the damage path's folded
 * instance pointer; `actor` reads `TargetEntry.actorIndex`, the coarser index
 * every other capture path reports.
 *
 * The time rule is the parser's own (`segment_at` in `parser/v1/status.rs`),
 * deliberately copied rather than re-invented: segments for one index are
 * chronological and disjoint, so the spawn alive at `atMs` is the LAST one to
 * have started by then. Falling back to the FIRST segment when none has —
 * rather than to no match at all — is the same tolerance, and it is what names
 * a debuff that landed on an enemy a moment before that enemy's own first
 * damage event, which is where its segment starts. */
export const spawnSegmentAt = (
  entries: TargetEntry[],
  targetIndex: number,
  atMs: number,
  space: ActorSpace
): number => {
  let first = -1;
  let current = -1;
  entries.forEach((entry, index) => {
    if ((space === "spawn" ? entry.id : entry.actorIndex) !== targetIndex) return;
    if (first === -1) first = index;
    if (entry.startMs <= atMs) current = index;
  });
  return current === -1 ? first : current;
};
