import type { Hostility, RowLevel } from "../metrics/types";

import type { DpsChartProps } from "./DpsChart";
import type { Dimension, MetricKey } from "./machine/state";
import type { DrillSeries } from "./statusChart";

/** What the plot is titled once it decomposes a pinned row, per level. */
const DRILL_LABEL_KEY = {
  players: "ui.logs.chart-dps-label",
  abilities: "ui.logs.chart-drill-ability-label",
  // The chart always stacks by enemy here. The table agrees when the pinned row
  // held one action and decomposed into enemies too, and lists the group's
  // members when it held several — the plot stays the coarser of the two.
  skills: "ui.logs.chart-drill-target-label",
} as const;

/** Which series the plot ended up drawing, and how it is presented.
 *
 * Everything here reads only from series that have ALREADY been derived plus
 * the resolved machine state, so it is a pure fold of them — no store, no
 * i18n, no React. Extracted from the view because these were the last
 * chart decisions with no test able to reach them: nothing mounts the chart
 * (recharts' `ResponsiveContainer` measures zero in jsdom), so the title
 * ternary and the Total-series rule were only ever exercised by eye.
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
  /** i18next key naming what is plotted. */
  labelKey: string;
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
  effectSeries: DrillSeries[] | null,
  groupOverlay: DrillSeries[] | null,
  abilitySeries: DrillSeries[] | null
): DrillSeries[] | null => statusSeries ?? effectSeries ?? groupOverlay ?? abilitySeries;

export const chartPresentation = ({
  statusSeries,
  effectSeries,
  groupOverlay,
  abilitySeries,
  groupPlayerSeries,
  groupsPath,
  groupBy,
  hostility,
  metricKey,
  level,
  metricLabelKey,
  metricFormat,
  rateSmoothing,
}: {
  /** One series per holder of the pinned effect, or null. */
  statusSeries: DrillSeries[] | null;
  /** The effects themselves as holder counts, or null. */
  effectSeries: DrillSeries[] | null;
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
  metricKey: MetricKey;
  /** The legacy row level, a projection of `groupBy`. */
  level: RowLevel;
  /** The base chart's own title key, used when nothing overlays it. */
  metricLabelKey: string;
  /** The base chart's own format (the SBA gauge is a percent). */
  metricFormat: "amount" | "percent";
  /** The trailing window a RATE chart smooths over. Injected rather than
   * imported so this stays a pure fold with no view constants in it. */
  rateSmoothing: number;
}): ChartPresentation => {
  // Whichever series is drawn INSTEAD of the per-player ones. Stack counts and
  // group bands are the same shape and are consumed identically, so they are
  // one branch here rather than the same ternary spelled out per field.
  const overlay = overlayOf(statusSeries, effectSeries, groupOverlay, abilitySeries);

  // WHICH of those the plot ended up drawing, recognised from the value itself
  // rather than re-derived from the pins, so the title cannot disagree with
  // what is on screen. "scoped" is the groups path's per-player lines (the
  // query's filters applied); "drill" its stacked bands.
  const chartSource: "base" | "scoped" | "stacks" | "drill" | "ability" =
    overlay === null
      ? groupPlayerSeries
        ? "scoped"
        : "base"
      : overlay === statusSeries || overlay === effectSeries
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

  // Whether the enemy side is actually on screen. `hostility` is already the
  // EFFECTIVE side (the resolver's rule: a metric with no enemy side reads
  // friendly whatever the URL says), so this one spelling keeps the chart, its
  // title, the hover cards and the empty state agreeing about what is showing.
  const enemySide = hostility === "enemy";

  // An overlay of any kind plots an amount; the base sources keep their metric's
  // own format (the SBA gauge is a percent). A drilled SBA chart plots gauge
  // GENERATED, an amount, where the undrilled one plots the gauge LEVEL — the
  // axis follows the grouping, the same way the title does. Hoisted out of the
  // literal below because `smoothing` keys off it: in this view "amount" IS the
  // spelling for "this series is a rate".
  const format: DpsChartProps["format"] =
    chartSource === "stacks" ? "count" : chartSource === "ability" || groupOverlay !== null ? "amount" : metricFormat;

  return {
    overlay,
    chartSource,
    withTotal,
    // Titled after what is DRAWN, never after what the pins would suggest.
    labelKey:
      chartSource === "ability"
        ? // The derived tabs decompose into their own abilities, and the SBA
          // one changes QUANTITY as it does (see `format`), so it says so.
          metricKey === "sba"
          ? "ui.logs.chart-sba-drill-label"
          : "ui.logs.chart-stun-drill-label"
        : chartSource === "stacks"
          ? // Pinned, the plot is one effect's stack depths; unpinned it is
            // the effects themselves as holder counts.
            statusSeries !== null
            ? "ui.logs.chart-stacks-label"
            : "ui.logs.chart-effects-label"
          : groupOverlay !== null
            ? // The enemy side inverts which way the damage flows, so both
              // of these name both ends. Reusing the friendly titles would
              // leave the heading unchanged across a toggle that swapped
              // the plotted quantity for its opposite.
              enemySide
              ? metricKey === "damage"
                ? "ui.logs.chart-enemy-dealt-label"
                : "ui.logs.chart-enemy-received-label"
              : metricKey === "taken"
                ? "ui.logs.chart-taken-drill-label"
                : DRILL_LABEL_KEY[level]
            : metricLabelKey,
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
