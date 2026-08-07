import { millisecondsToElapsedFormat } from "@/utils";

import "../analysis/analysis.css";

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
 * outside this scroller, and it opens with `.timeline-ruler-gap` at exactly this
 * ruler's height. */
export const TimelineRuler = ({ domainMs, startMs, stepMs }: TimelineRulerProps) => (
  <div className="timeline-ruler">
    <div className="timeline-ruler-track">
      {tickTimes(domainMs, stepMs).map((at) => (
        <span
          key={at}
          className="timeline-ruler-tick"
          style={{ left: domainMs === 0 ? "0%" : `${((at / domainMs) * 100).toFixed(4)}%` }}
        >
          {millisecondsToElapsedFormat(startMs + at)}
        </span>
      ))}
    </div>
  </div>
);
