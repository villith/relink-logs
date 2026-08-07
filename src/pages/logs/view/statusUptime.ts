import type { StatusInterval } from "@/types";

import { clipSpans, mergeSpans } from "./spans";

/** Identity of a buff row: the effect, the ability that caused it, AND the
 * status class that applied it. Unresolved causes and classes collapse to one
 * "unknown" bucket per effect rather than scattering — the documented fallback
 * when the hook cannot attribute.
 *
 * The class segment is ALWAYS written; absence is spelled, not omitted, so the
 * grammar keeps exactly one shape for its four readers. That is safe because
 * this key is DERIVED at every use site and never stored — the only
 * two-segment key that can outlive the change is a bookmarked pin, which
 * already renders verbatim against an empty table.
 *
 * The class splits rows ACROSS holders, not within one: within a single
 * `(actor, spawn, effect, cause)` the parser still merges, so the first class
 * wins. `casterActionId` is deliberately NOT here — it is inferred rather than
 * recorded, and keying on it would split rows by a guess. */
export const statusKey = (interval: Pick<StatusInterval, "statusId" | "abilityId" | "statusClass">): string =>
  `${interval.statusId}:${interval.abilityId ?? "unknown"}:${interval.statusClass ?? "unknown"}`;

/** The prefix that keeps a status pin tellable apart from a damage-ability pin
 * in the Ability selector they share. Spelled once, here, beside the key it
 * prefixes — the grammar has four readers across three directories and they
 * must not drift. */
export const STATUS_PIN_PREFIX = "status:";

/** `statusKey` prefixed, i.e. the value a status row pins. */
export const statusPinKey = (interval: Pick<StatusInterval, "statusId" | "abilityId" | "statusClass">): string =>
  `${STATUS_PIN_PREFIX}${statusKey(interval)}`;

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
 * nothing to uptime but would still draw a row — `overlapsWindow`'s rule. */
export const clipToWindow = (intervals: StatusInterval[], startMs: number, endMs: number): StatusInterval[] =>
  clipSpans(intervals, { startMs, endMs });

/** Total milliseconds covered, merging overlaps.
 *
 * Two sources of one effect on one actor is 100% uptime, not 200% — summing
 * durations naively would report the latter. */
export const uptimeMs = (intervals: StatusInterval[]): number =>
  mergeSpans(intervals).reduce((total, interval) => total + (interval.endMs - interval.startMs), 0);
