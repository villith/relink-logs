import type { NestedEventRow } from "./nestSupplementary";

const CLOCK = /^(\d+):(\d{1,2})(\.\d+)?$/;
const MILLISECONDS = /^(\d+(?:\.\d+)?)\s*ms$/i;
const SECONDS = /^(\d+(?:\.\d+)?)\s*s$/i;
const BARE = /^\d+(?:\.\d+)?$/;

/** A typed time, in milliseconds, or null for anything that is not one.
 *
 * Four spellings, because the column prints one of them and the reader may
 * have any of the others to hand: `1:23` is what the rows show, `83`/`83s` is
 * how a fight is usually discussed, and `83000ms` is what a delta or a log line
 * gives you.
 *
 * A bare number is SECONDS, not milliseconds: the fights are minutes long, so
 * `90` typed alone means a minute and a half far more often than a tenth of a
 * second. Milliseconds must say so. */
export const parseTimeInput = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const clock = CLOCK.exec(trimmed);
  if (clock) {
    const seconds = Number(clock[2]);
    // 0:75 is not a reading any row can print, so it names no row. Accepting it
    // as 75 seconds would scroll somewhere the reader did not ask for.
    if (seconds >= 60) return null;
    const fraction = clock[3] === undefined ? 0 : Number(clock[3]);
    return Math.round((Number(clock[1]) * 60 + seconds + fraction) * 1000);
  }

  const milliseconds = MILLISECONDS.exec(trimmed);
  if (milliseconds) return Math.round(Number(milliseconds[1]));

  const seconds = SECONDS.exec(trimmed);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);

  if (BARE.test(trimmed)) return Math.round(Number(trimmed) * 1000);

  return null;
};

/** The row a time names: the first one at or past it, in the order they are
 * drawn.
 *
 * Scanned linearly rather than bisected: nesting lifts an echo out of its own
 * position (see `nestSupplementary`), so the list this runs over is not sorted
 * and a binary search would land wherever the disorder put it. Nothing at or
 * past the time yields null, which leaves the view where it was instead of
 * pinning it to the last row. */
export const rowAtTime = (rows: readonly NestedEventRow[], ms: number): number | null => {
  const index = rows.findIndex((row) => row.timeMs >= ms);
  return index === -1 ? null : index;
};

/** Where to put the scroll so a landed row is READ rather than merely rendered.
 *
 * Centred in the space the sticky header leaves, not scrolled to the top: a row
 * pinned to the top edge is a row with no context above it, and the events
 * either side are most of why anyone jumped there. The header's own height is
 * subtracted because it overlays the first rows of the list — a row placed
 * without it lands underneath the column names.
 *
 * Clamped at both ends, so a match in the first or last screenful returns a
 * position that exists. */
export const scrollTopFor = ({
  index,
  rowHeight,
  viewportHeight,
  headHeight,
  total,
}: {
  index: number;
  rowHeight: number;
  viewportHeight: number;
  headHeight: number;
  total: number;
}): number => {
  const centred = index * rowHeight - (viewportHeight - headHeight - rowHeight) / 2;
  const furthest = Math.max(0, headHeight + total * rowHeight - viewportHeight);
  return Math.round(Math.min(Math.max(centred, 0), furthest));
};
