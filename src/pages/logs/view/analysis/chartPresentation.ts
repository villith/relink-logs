import type { Hostility } from "../metrics/types";

import type { DpsChartProps } from "./DpsChart";
import type { Dimension } from "./machine/state";
import type { DrillSeries } from "./statusChart";

/** Which series the plot ended up drawing, and how it is presented.
 *
 * Everything here reads only from series that have ALREADY been derived plus
 * the resolved machine state, so it is a pure fold of them — no store, no
 * i18n, no React. Extracted from the view because these were the last
 * chart decisions with no test able to reach them: nothing mounts the chart
 * (recharts' `ResponsiveContainer` measures zero in jsdom), so the Total-series
 * rule was only ever exercised by eye.
 *
 * The four series inputs are compared BY REFERENCE, not by shape — `overlay`
 * is whichever of them won, so `overlay === statusSeries` recognises the plot
 * from the value itself rather than re-deriving it from the pins. Rebuilding
 * any of these arrays on the way in would silently reclassify the chart. */
export type ChartPresentation = {
  /** Whichever series is drawn INSTEAD of the per-player ones, or null. */
  overlay: DrillSeries[] | null;
  chartSource: "base" | "scoped" | "stacks" | "drill" | "ability";
  withTotal: boolean;
  format: DpsChartProps["format"];
  stacked: boolean;
  /** Trailing moving-average window in buckets; 1 leaves values untouched. */
  smoothing: number;
};

/** Which of the four builders draws INSTEAD of the per-player lines.
 *
 * Named and exported so this module and `useChartModel` cannot disagree about
 * the precedence — the chain used to be spelled out in both.
 *
 * Returns the winner BY REFERENCE, which is load-bearing: the classification
 * below recognises which plot it is by comparing `overlay === statusSeries` and
 * friends, so rebuilding the array would silently reclassify the chart, and
 * with it the title, the axis format and whether a Total series is drawn. */
export const overlayOf = (
  statusSeries: DrillSeries[] | null,
  groupOverlay: DrillSeries[] | null,
  abilitySeries: DrillSeries[] | null
): DrillSeries[] | null => statusSeries ?? groupOverlay ?? abilitySeries;

export const chartPresentation = ({
  statusSeries,
  groupOverlay,
  abilitySeries,
  groupPlayerSeries,
  groupsPath,
  groupBy,
  hostility,
  metricFormat,
  rateSmoothing,
}: {
  /** One series per holder of the pinned effect, or null.
   *
   * The ONLY thing the aura tabs overlay their chart with. Unpinned, they used
   * to plot the effects themselves as holder counts — a plot that answered a
   * question the table beside it already answers better, while hiding the
   * damage the effects are being read against. Now nothing overlays them until
   * an effect is pinned, and the tab keeps the metric's own damage plot. */
  statusSeries: DrillSeries[] | null;
  /** The fetched aggregates' stacked bands, or null. */
  groupOverlay: DrillSeries[] | null;
  /** The derived tabs' per-ability bands (Stun/SBA drilled in), or null.
   * Last in the overlay chain: the groups path never produces these, and the
   * aura tabs never drill by ability, so the orders cannot both apply. */
  abilitySeries: DrillSeries[] | null;
  /** The groups path's per-player lines, or null. Truthiness only. */
  groupPlayerSeries: Record<number, number[]> | null;
  /** Whether this metric's rows come from the GroupQuery aggregation. */
  groupsPath: boolean;
  /** The resolved grouping. */
  groupBy: Dimension;
  /** The EFFECTIVE side (a metric with no enemy side reads friendly). */
  hostility: Hostility;
  /** The base chart's own format (the SBA gauge is a percent). */
  metricFormat: "amount" | "percent";
  /** The trailing window a RATE chart smooths over. Injected rather than
   * imported so this stays a pure fold with no view constants in it. */
  rateSmoothing: number;
}): ChartPresentation => {
  // Whichever series is drawn INSTEAD of the per-player ones. Stack counts and
  // group bands are the same shape and are consumed identically, so they are
  // one branch here rather than the same ternary spelled out per field.
  const overlay = overlayOf(statusSeries, groupOverlay, abilitySeries);

  // WHICH of those the plot ended up drawing, recognised from the value itself
  // rather than re-derived from the pins, so the axis format cannot disagree
  // with what is on screen. "scoped" is the groups path's per-player lines (the
  // query's filters applied); "drill" its stacked bands.
  const chartSource: "base" | "scoped" | "stacks" | "drill" | "ability" =
    overlay === null
      ? groupPlayerSeries
        ? "scoped"
        : "base"
      : overlay === statusSeries
        ? "stacks"
        : overlay === abilitySeries
          ? "ability"
          : "drill";

  // The Total series draws exactly where the chart draws independent LINES:
  // the groups path's source grouping on the friendly side (Damage Done and
  // Damage Taken), from either the group series or the base-chart fallback.
  // Stacked charts (drills, and the whole enemy side) already show the total
  // as the stack's height, and a Total series inside a Mantine stacked
  // AreaChart would be ADDED to the stack and double it.
  const withTotal = groupsPath && groupBy === "source" && hostility === "friendly" && overlay === null;

  // An overlay of any kind plots an amount; the base sources keep their metric's
  // own format (the SBA gauge is a percent). A drilled SBA chart plots gauge
  // GENERATED, an amount, where the undrilled one plots the gauge LEVEL — the
  // axis follows the grouping. Hoisted out of the literal below because
  // `smoothing` keys off it: in this view "amount" IS the spelling for "this
  // series is a rate".
  const format: DpsChartProps["format"] =
    chartSource === "stacks" ? "count" : chartSource === "ability" || groupOverlay !== null ? "amount" : metricFormat;

  return {
    overlay,
    chartSource,
    withTotal,
    format,
    stacked: overlay !== null,
    // RATES are smoothed; LEVELS are not. The SBA gauge and the aura stack
    // counts are levels — averaged over a trailing window a buff held for one
    // second at four stacks reads as one, and the discharge that IS the gauge
    // reading is rounded off. A DRILLED SBA chart is the case that makes this
    // follow `format` rather than the metric: it plots gauge GENERATED per
    // bucket, a rate like DPS, and left unsmoothed it drew one spike per
    // per-hit gain burst.
    smoothing: format === "amount" ? rateSmoothing : 1,
  };
};
