import type { MetricRow } from "../metrics/types";
import { sectionHeadings } from "../sectionRuns";

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
 * The heading rule is `sectionHeadings`, the same one `MetricTable` applies —
 * shared rather than re-spelled, because the table and the timeline are drawing
 * one row set and must title it identically. */
export const laneRows = (lanes: Lane[], sectionLabel?: (row: MetricRow) => string | null): LaneRow[] => {
  const headings = sectionHeadings(lanes, (lane) => sectionLabel?.(lane.row) ?? null);
  const rows: LaneRow[] = [];

  lanes.forEach((lane, index) => {
    const heading = headings[index];
    if (heading !== null) rows.push({ kind: "heading", key: `heading:${index}:${heading}`, label: heading });
    rows.push({ kind: "lane", key: `lane:${lane.row.key}`, lane });
  });

  return rows;
};
