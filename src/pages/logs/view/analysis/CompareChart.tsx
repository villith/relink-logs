import { useMemo } from "react";

import type { Label } from "../DetailCharts";
import { bucketLabel } from "../DetailCharts";

import { DpsChart, type DpsChartProps } from "./DpsChart";
import { compareChartData, compareSeriesKey, paneSeriesColor, paneSeriesLabel } from "./compareSeries";

export type CompareChartProps = {
  /** One totals array per pane, in pane order. */
  perPaneTotals: number[][];
  /** The log each pane is showing, which is how its line is named. */
  paneLogIds: number[];
  format: DpsChartProps["format"];
  onScope: DpsChartProps["onScope"];
  /** Where each pane's fight ran out. The longest run's own entry draws
   * nothing — `DpsChart` drops a rule at or past the last bucket — so this is
   * every pane's end and not "the short ones'". */
  endLines: DpsChartProps["endLines"];
  /** The fight-clock bucket the first plotted point stands on — the committed
   * zoom's start, or 0 unzoomed. The panes publish totals already cropped to
   * the window, so without it the axis would restart at 0:00 and print a
   * different clock for the same points than each pane's own chart does. */
  startBucket?: number;
  smoothing?: DpsChartProps["smoothing"];
  onSmoothingChange?: DpsChartProps["onSmoothingChange"];
  /** The chart controls that fold more than this plot — see `DpsChart`. */
  controls?: DpsChartProps["controls"];
};

/** The shared plot while more than one log is open: one line per pane, on one
 * time axis.
 *
 * ALWAYS unstacked. A stacked area of two runs would sum two different fights
 * into one height, which is not a quantity — comparing runs is reading two
 * lines against each other, not adding them.
 *
 * The per-pane bands the single-log chart draws are deliberately not here: two
 * logs' worth of stacked players is sixteen bands nobody can read. Each log's
 * full chart is one click away — that is what the split layout is for. */
export const CompareChart = ({
  perPaneTotals,
  paneLogIds,
  format,
  onScope,
  endLines,
  startBucket = 0,
  smoothing,
  onSmoothingChange,
  controls,
}: CompareChartProps) => {
  const data = useMemo(
    () => compareChartData(perPaneTotals, (bucket) => bucketLabel(startBucket + bucket)),
    [perPaneTotals, startBucket]
  );

  const labels: Label = useMemo(
    () =>
      perPaneTotals.map((_, paneIndex) => ({
        name: compareSeriesKey(paneIndex),
        label: paneSeriesLabel(paneLogIds, paneIndex),
        // No party slot — a whole log is not a party member.
        partySlotIndex: -1,
        color: paneSeriesColor(paneIndex),
      })),
    [perPaneTotals, paneLogIds]
  );

  return (
    <DpsChart
      data={data}
      labels={labels}
      labelKey="ui.logs.compare-series-label"
      sectionKey="ui.logs.compare-series-label"
      format={format}
      stacked={false}
      onScope={onScope}
      endLines={endLines}
      smoothing={smoothing}
      onSmoothingChange={onSmoothingChange}
      controls={controls}
    />
  );
};
