import type { LogSummary } from "@/types";
import { COMPARE_COLORS, epochToLocalTime } from "@/utils";

import type { ChartDatapoint, Label } from "../DetailCharts";

import { TOTAL_SERIES_KEY } from "./chartSeries";

/** A pane's series name. Keyed by PANE INDEX, not by log id: one log may fill
 * two panes with different pins, and two series sharing a key would collapse
 * into one line. */
export const compareSeriesKey = (paneIndex: number): string => `pane${paneIndex}`;

/** A pane's series colour — and, through the callers below, the colour the log
 * wears wherever else it is named: its column's title, its selector in the
 * shared actor bar, its line, and the rule marking where it ended. ONE author,
 * so a column and the line it explains can never come to be different colours.
 *
 * From the LOG palette, not the player one: a pane colour and a party colour are
 * on screen together in the split layout, and nothing here is red or amber,
 * which everywhere else in this app means something is wrong (see
 * `COMPARE_COLORS`). */
export const paneSeriesColor = (paneIndex: number): string => COMPARE_COLORS[paneIndex % COMPARE_COLORS.length];

/** A pane's series name where the room for it is the PLOT: the id alone.
 *
 * The end rules use this — they are SVG text drawn at the rule's own x, and in a
 * split layout the column is half the page wide. The legend directly above
 * carries the full name in the same colour, so the rule only has to say which of
 * the two lines it belongs to. */
export const paneSeriesShortLabel = (logId: number | undefined): string => `#${logId ?? "?"}`;

/** Each pane's series name as the reader sees it: the log id AND when the run
 * happened.
 *
 * Not the quest name — two panes usually carry ONE quest, which is the whole
 * point of a comparison, so the quest is the one thing that cannot tell the two
 * lines apart. What does is when they were run, and the id is what the picker
 * beside them writes. The stamp is `epochToLocalTime`, the same author the
 * picker's own rows read a run's date through, so a line and the row it was
 * chosen from cannot print two different times.
 *
 * A log the library has not handed over yet — the load is still in flight, or a
 * bookmarked URL names a deleted run — keeps the bare id, which still says which
 * log the line is where an empty label would leave it nameless. */
export const paneSeriesLabels = (paneLogIds: number[], logs: LogSummary[]): string[] => {
  const byId = new Map(logs.map((log) => [log.id, log]));
  return paneLogIds.map((logId) => {
    const log = byId.get(logId);
    return log === undefined
      ? paneSeriesShortLabel(logId)
      : `${paneSeriesShortLabel(log.id)} · ${epochToLocalTime(log.time)}`;
  });
};

/** One pane's plot, flattened to a single number per bucket — what an overlay
 * of two runs compares.
 *
 * The chart's own Total series is preferred where the points carry one: it was
 * summed over every FETCHED series, while the labels here are only the ones the
 * legend lists, and re-summing them would disagree with the number the pane's
 * own tooltip shows. Summing the labels is the fallback for the plots that
 * carry no total (the levels — the SBA gauge, the aura stacks). */
export const paneTotals = (data: ChartDatapoint[], labels: Label): number[] =>
  data.map((point) => {
    const total = point[TOTAL_SERIES_KEY];
    if (typeof total === "number") return total;
    return labels.reduce((sum, series) => sum + (point[series.name] ?? 0), 0);
  });

/** One line per pane, on one time axis.
 *
 * Runs differ in length, so the axis spans the LONGEST and a shorter run's
 * series is simply absent past its end — absent, not zero: zero would draw a
 * line along the floor and read as "did nothing" rather than "was over".
 *
 * The bucket LABEL comes from the caller, which passes the shared `bucketLabel`
 * — one author for the clock, so the overlay's x-values and the per-pane
 * charts' cannot put two different times on one axis. */
export const compareChartData = (
  perPaneTotals: number[][],
  bucketLabel: (bucket: number) => string
): ChartDatapoint[] => {
  const length = Math.max(0, ...perPaneTotals.map((totals) => totals.length));
  return Array.from({ length }, (_, bucket) => {
    const point = { timestamp: bucketLabel(bucket) } as ChartDatapoint;
    perPaneTotals.forEach((totals, paneIndex) => {
      if (bucket < totals.length) point[compareSeriesKey(paneIndex)] = totals[bucket];
    });
    return point;
  });
};
