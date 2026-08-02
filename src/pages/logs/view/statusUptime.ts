import type { StatusInterval } from "@/types";

/** Identity of a buff row: the effect AND the ability that caused it.
 * Unresolved causes collapse to one "unknown" bucket per effect rather than
 * scattering — the documented fallback when the hook cannot attribute. */
export const statusKey = (interval: StatusInterval): string =>
  `${interval.statusId}:${interval.abilityId ?? "unknown"}`;

/** Total milliseconds covered, merging overlaps.
 *
 * Two sources of one effect on one actor is 100% uptime, not 200% — summing
 * durations naively would report the latter. */
export const uptimeMs = (intervals: StatusInterval[]): number => {
  if (intervals.length === 0) return 0;

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let start = sorted[0].startMs;
  let end = sorted[0].endMs;

  for (const interval of sorted.slice(1)) {
    if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs);
      continue;
    }
    total += end - start;
    start = interval.startMs;
    end = interval.endMs;
  }

  return total + (end - start);
};
