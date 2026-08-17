import { millisecondsToElapsedFormat } from "@/utils";

/** A CSS percentage across the track, at the precision a sub-pixel position
 * needs and no more — `toFixed` keeps the DOM stable across renders where a raw
 * float would not.
 *
 * One author, because the ruler's ticks and the lanes' marks draw into the same
 * scroll container and have to agree pixel-for-pixel about where a moment sits. */
export const percent = (value: number, of: number): string => (of === 0 ? "0%" : `${((value / of) * 100).toFixed(4)}%`);

/** Tick offsets across the domain, in milliseconds from its start.
 *
 * Never past the end: a tick beyond the track renders outside it and widens
 * the scroll container, which then scrolls past the last lane's marks. */
export const tickTimes = (domainMs: number, stepMs: number): number[] => {
  const times: number[] = [];
  for (let at = 0; at <= domainMs; at += stepMs) times.push(at);
  return times;
};

export type TimelineRulerProps = {
  /** The window's length in milliseconds — what 100% of the track is. */
  domainMs: number;
  /** The window's start in ABSOLUTE fight time, so labels read the way the
   * chart above them does. */
  startMs: number;
  stepMs: number;
};

/** The time axis. Shares its HORIZONTAL scroll container with the lanes' tracks,
 * so the two cannot disagree about where a moment sits.
 *
 * No name-column spacer of its own any more: the names are a separate column
 * outside this scroller, which opens with a gap of exactly this ruler's height.
 *
 * `h-head` INCLUDING its border — every height here is border-box, so the rule
 * sits inside the stated height and adds nothing. That is what puts lane one at
 * the same y in both columns. */
export const TimelineRuler = ({ domainMs, startMs, stepMs }: TimelineRulerProps) => (
  <div className="flex h-head border-b border-line bg-[var(--mantine-color-body)]">
    <div className="relative min-w-0 flex-1">
      {tickTimes(domainMs, stepMs).map((at) => (
        <span
          key={at}
          data-ruler-tick
          className="absolute inset-y-0 whitespace-nowrap border-l border-line pl-[3px] text-label leading-[var(--spacing-head)] text-[var(--mantine-color-dimmed)]"
          style={{ left: percent(at, domainMs) }}
        >
          {millisecondsToElapsedFormat(startMs + at)}
        </span>
      ))}
    </div>
  </div>
);
