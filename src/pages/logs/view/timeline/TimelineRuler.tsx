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

/** The time axis. Shares its scroll container with the lanes, so the two
 * cannot disagree about where a moment sits. */
export const TimelineRuler = ({ domainMs, startMs, stepMs }: TimelineRulerProps) => (
  <div className="timeline-ruler">
    {/* Matches the lanes' sticky name column, so tick zero lines up with the
        left edge of the tracks rather than with the left edge of the view. */}
    <div className="timeline-ruler-spacer" />
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
