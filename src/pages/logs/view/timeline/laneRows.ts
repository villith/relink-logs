import type { MetricRow } from "../metrics/types";

import type { Lane } from "./laneMarks";

/** One rendered row of the timeline: a section heading, or a lane. */
export type LaneRow = { kind: "heading"; key: string; label: string } | { kind: "lane"; key: string; lane: Lane };

/** The timeline's rows, headings included, in render order.
 *
 * Derived ONCE and rendered twice — the fixed name column and the scrolling
 * track column both map this list. Two columns each applying the heading rule
 * for themselves is how they would come to differ by a row, and a timeline
 * whose names are one row out of step with its marks is worse than none.
 *
 * The heading rule is `MetricTable`'s: emit one only where the section CHANGES
 * between consecutive rows, so a run of rows in one section is titled once. */
export const laneRows = (lanes: Lane[], sectionLabel?: (row: MetricRow) => string | null): LaneRow[] => {
  const rows: LaneRow[] = [];
  let previous: string | null = null;

  lanes.forEach((lane, index) => {
    const section = sectionLabel?.(lane.row) ?? null;
    if (section !== null && section !== previous) {
      rows.push({ kind: "heading", key: `heading:${index}:${section}`, label: section });
    }
    previous = section;
    rows.push({ kind: "lane", key: `lane:${lane.row.key}`, lane });
  });

  return rows;
};
