import type { StatusInterval } from "@/types";

/** Identity of a buff row: the effect AND the ability that caused it.
 * Unresolved causes collapse to one "unknown" bucket per effect rather than
 * scattering — the documented fallback when the hook cannot attribute. */
export const statusKey = (interval: StatusInterval): string =>
  `${interval.statusId}:${interval.abilityId ?? "unknown"}`;

/** The prefix that keeps a status pin tellable apart from a damage-ability pin
 * in the Ability selector they share. Spelled once, here, beside the key it
 * prefixes — the grammar has four readers across three directories and they
 * must not drift. */
export const STATUS_PIN_PREFIX = "status:";

/** `statusKey` prefixed, i.e. the value a status row pins. */
export const statusPinKey = (interval: StatusInterval): string => `${STATUS_PIN_PREFIX}${statusKey(interval)}`;

/** Whether an Ability pin selects a status effect rather than a damage ability.
 *
 * Read well outside the descriptors: the scoped fetch, the selector cascade,
 * the row level and the label renderer each have to recognise a status pin, and
 * every one of them means something different by a damage ability. Lives here
 * rather than in `metrics/buffs` so `selectorOptions`/`deriveRows` can import it
 * without the cycle that would create. */
export const isStatusPin = (pin: string | null): pin is string => pin !== null && pin.startsWith(STATUS_PIN_PREFIX);

/** The intervals that overlap `[startMs, endMs)`, cropped to it.
 *
 * The backend sends whole-fight windows so the tables can narrow without
 * another round trip — this is that narrowing. Without it, scrubbing to ten
 * seconds of a four-minute fight redrew the chart and reparsed every other
 * table while the Buffs table beside them kept reporting the whole pull.
 *
 * Intervals only touching an edge are dropped: at zero width they contribute
 * nothing to uptime but would still draw a row. */
export const clipToWindow = (intervals: StatusInterval[], startMs: number, endMs: number): StatusInterval[] =>
  intervals
    .filter((interval) => interval.startMs < endMs && interval.endMs > startMs)
    .map((interval) => ({
      ...interval,
      startMs: Math.max(startMs, interval.startMs),
      endMs: Math.min(endMs, interval.endMs),
    }));

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

