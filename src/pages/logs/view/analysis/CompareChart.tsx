import { useMemo } from "react";

import { PLAYER_COLORS, millisecondsToElapsedFormat } from "@/utils";

import type { Label } from "../DetailCharts";
import { DPS_BUCKET_MS } from "../DetailCharts";

import { DpsChart, type DpsChartProps } from "./DpsChart";
import { compareChartData, compareSeriesKey } from "./compareSeries";

export type CompareChartProps = {
  /** One totals array per pane, in pane order. */
  perPaneTotals: number[][];
  /** The log each pane is showing, which is how its line is named. */
  paneLogIds: number[];
  format: DpsChartProps["format"];
  onScope: DpsChartProps["onScope"];
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
export const CompareChart = ({ perPaneTotals, paneLogIds, format, onScope }: CompareChartProps) => {
  const data = useMemo(
    () => compareChartData(perPaneTotals, (bucket) => millisecondsToElapsedFormat(bucket * DPS_BUCKET_MS)),
    [perPaneTotals]
  );

  const labels: Label = useMemo(
    () =>
      perPaneTotals.map((_, paneIndex) => ({
        name: compareSeriesKey(paneIndex),
        // A log id, not a quest name: two panes may carry one quest, and the id
        // is what the picker beside them already writes.
        label: `#${paneLogIds[paneIndex] ?? paneIndex}`,
        // No party slot — a whole log is not a party member.
        partySlotIndex: -1,
        color: PLAYER_COLORS[paneIndex % PLAYER_COLORS.length],
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
    />
  );
};
