import { useMemo } from "react";

import type { Label } from "../DetailCharts";
import { bucketLabel } from "../DetailCharts";

import { DpsChart, type DpsChartProps } from "./DpsChart";
import { compareChartData, compareSeriesKey, paneSeriesColor } from "./compareSeries";

export type CompareChartProps = {
  /** One totals array per pane, in pane order. */
  perPaneTotals: number[][];
  /** What each pane's line is CALLED — its log's id and when the run happened,
   * resolved once by the frame (see `paneSeriesLabels`). Names rather than ids,
   * because naming a run needs the log library and there is one of that for the
   * whole view, not one per chart. */
  paneLabels: string[];
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
  /** Every pane's battle-state windows, merged by `compareWindowBands` /
   * `compareWindowTooltips`. The shading is the one part of a pane's own plot
   * that survives the overlay: it says nothing about a pane's series, it says
   * what the FIGHT was doing, which is exactly what two runs are being read
   * against. */
  windowBands?: DpsChartProps["windowBands"];
  windowTooltips?: DpsChartProps["windowTooltips"];
  hiddenWindowKinds?: DpsChartProps["hiddenWindowKinds"];
  onToggleWindowKind?: DpsChartProps["onToggleWindowKind"];
  /** Every pane's death and SBA-cast markers, merged and tagged by
   * `compareMarkers`. Here for the same reason the window shading is — an
   * individual Skybound Art is an event in the fight, not a decomposition of one
   * log's output — and load-bearing beside it: the SBA shading merges a chain
   * into one span, so only these say how many casts made it and who cast them. */
  markers?: DpsChartProps["markers"];
  hiddenMarkerKinds?: DpsChartProps["hiddenMarkerKinds"];
  onToggleMarkerKind?: DpsChartProps["onToggleMarkerKind"];
  /** The chart controls that fold more than this plot — see `DpsChart`. */
  controls?: DpsChartProps["controls"];
};

/** The hover card's width on this plot.
 *
 * Wider than a single log's (`TOOLTIP_WIDTH`, 320) because every row here names
 * a whole run rather than a party member — "#2657 · 15/08/2026, 21:04" beside
 * an amount and a share — and the window lines carry that id on top of the span
 * they already state. At the default it was exactly the part telling the two
 * runs apart that ellipsized. */
const COMPARE_TOOLTIP_WIDTH = 460;

/** The shared plot while more than one log is open: one line per pane, on one
 * time axis.
 *
 * ALWAYS unstacked. A stacked area of two runs would sum two different fights
 * into one height, which is not a quantity — comparing runs is reading two
 * lines against each other, not adding them.
 *
 * The per-pane SERIES bands the single-log chart draws are deliberately not
 * here: two logs' worth of stacked players is sixteen bands nobody can read.
 * Each log's full chart is one click away — that is what the split layout is
 * for. The battle-state windows and the death/SBA markers ARE here, because
 * they describe the fight rather than a decomposition of one log's output. */
export const CompareChart = ({
  perPaneTotals,
  paneLabels,
  format,
  onScope,
  endLines,
  startBucket = 0,
  smoothing,
  onSmoothingChange,
  windowBands,
  windowTooltips,
  hiddenWindowKinds,
  onToggleWindowKind,
  markers,
  hiddenMarkerKinds,
  onToggleMarkerKind,
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
        label: paneLabels[paneIndex] ?? "",
        // No party slot — a whole log is not a party member.
        partySlotIndex: -1,
        color: paneSeriesColor(paneIndex),
      })),
    [perPaneTotals, paneLabels]
  );

  return (
    <DpsChart
      data={data}
      labels={labels}
      sectionKey="ui.logs.compare-series-label"
      format={format}
      stacked={false}
      onScope={onScope}
      endLines={endLines}
      smoothing={smoothing}
      onSmoothingChange={onSmoothingChange}
      windowBands={windowBands}
      windowTooltips={windowTooltips}
      hiddenWindowKinds={hiddenWindowKinds}
      onToggleWindowKind={onToggleWindowKind}
      markers={markers}
      hiddenMarkerKinds={hiddenMarkerKinds}
      onToggleMarkerKind={onToggleMarkerKind}
      tooltipWidth={COMPARE_TOOLTIP_WIDTH}
      controls={controls}
    />
  );
};
