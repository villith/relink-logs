import type { ChartDatapoint, Label } from "../DetailCharts";

import { TOTAL_SERIES_KEY } from "./chartSeries";

/** A pane's series name. Keyed by PANE INDEX, not by log id: one log may fill
 * two panes with different pins, and two series sharing a key would collapse
 * into one line. */
export const compareSeriesKey = (paneIndex: number): string => `pane${paneIndex}`;

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
 * The bucket LABEL comes from the caller because it is the view's own clock
 * formatting, and two spellings of it would put two different times on one
 * axis. */
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
