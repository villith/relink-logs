import { LineChart } from "@mantine/charts";
import { Box, Paper, Text } from "@mantine/core";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReferenceArea } from "recharts";

import { humanizeNumbers } from "@/utils";

import type { ChartDatapoint, Label } from "../DetailCharts";

import { windowFromDrag } from "./scopeWindow";
import "./analysis.css";

export type DpsChartProps = {
  /** Already sliced to the committed window, so the chart IS the window. */
  data: ChartDatapoint[];
  labels: Label;
  /** Commits a window as bucket indexes RELATIVE TO `data`, or null to clear. */
  onScope: (window: [number, number] | null) => void;
  /** Drawn under the plot as the axis bounds. */
  fromLabel: string;
  toLabel: string;
};

// recharts types a tooltip entry as Payload<any, any>, which has no index
// signature; the same `any` escape hatch as DetailCharts' tooltip.
const ChartTooltip = ({
  label,
  payload,
}: {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
}) => {
  if (!payload) return null;
  return (
    <Paper px="md" py="sm" withBorder shadow="md" radius="md">
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {payload
        .filter((item) => item.value !== null && item.value !== undefined)
        .map((item) => {
          const [n, suffix] = humanizeNumbers(item.value as number);
          return (
            <Text key={String(item.name)} fz="sm">
              <Text component="span" c={item.color as string}>
                {String(item.name)}
              </Text>
              : {n}
              {suffix}
            </Text>
          );
        })}
    </Paper>
  );
};

/** Per-player DPS, and the drag that scopes the analysis window.
 *
 * The drag is recharts', not ours: `onMouseDown`/`onMouseMove`/`onMouseUp` carry
 * `activeTooltipIndex`, which is the bucket index under the pointer, and a
 * `<ReferenceArea>` child draws the band in chart space. Nothing here measures
 * the DOM.
 *
 * Committing does not shade — it re-slices. The parent hands back `data` cropped
 * to the window, so the chart becomes the window and the band has nothing left
 * to mark. */
export const DpsChart = ({ data, labels, onScope, fromLabel, toLabel }: DpsChartProps) => {
  const { t } = useTranslation();
  const anchor = useRef<number | null>(null);
  const [band, setBand] = useState<[number, number] | null>(null);

  const maxIndex = Math.max(0, data.length - 1);
  const at = (index: number | undefined) => (typeof index === "number" ? index : null);

  const end = (last: number | null) => {
    const start = anchor.current;
    anchor.current = null;
    setBand(null);
    if (start === null || last === null) return;
    onScope(windowFromDrag(start, last, maxIndex));
  };

  return (
    <Box style={{ padding: "10px 16px 8px" }}>
      <Text className="analysis-label" style={{ marginBottom: 5 }}>
        {t("ui.logs.chart-dps-label")}
      </Text>
      {/* Double-click sits on the wrapper, not in `lineChartProps`: recharts'
          CategoricalChartProps has no onDoubleClick, and the wrapper sees the
          same gesture anywhere over the plot. */}
      <Box onDoubleClick={() => onScope(null)}>
        <LineChart
          h={190}
        data={data}
        dataKey="timestamp"
        withDots={false}
        withLegend
        series={labels}
        valueFormatter={(value) => {
          const [n, suffix] = humanizeNumbers(value);
          return `${n}${suffix}`;
        }}
        yAxisProps={{ width: 60 }}
        xAxisProps={{ interval: "preserveStartEnd" }}
        lineChartProps={{
          margin: { top: 5, right: 5, bottom: 5, left: 5 },
          // Selecting text mid-drag would otherwise fight the gesture.
          style: { userSelect: "none" },
          onMouseDown: (state: { activeTooltipIndex?: number }) => {
            const index = at(state?.activeTooltipIndex);
            if (index === null) return;
            anchor.current = index;
            setBand([index, index]);
          },
          onMouseMove: (state: { activeTooltipIndex?: number }) => {
            if (anchor.current === null) return;
            const index = at(state?.activeTooltipIndex);
            if (index === null) return;
            setBand([anchor.current, index]);
          },
          onMouseUp: (state: { activeTooltipIndex?: number }) => end(at(state?.activeTooltipIndex)),
          // A drag that leaves the plot still has to end, or the next move over
          // it would extend a stale selection.
          onMouseLeave: () => {
            anchor.current = null;
            setBand(null);
          },
        }}
        tooltipProps={{
          content: ({ label, payload }) => <ChartTooltip label={label} payload={payload} />,
        }}
      >
        {band && band[0] !== band[1] && (
          <ReferenceArea
            x1={data[Math.min(band[0], band[1])]?.timestamp}
            x2={data[Math.max(band[0], band[1])]?.timestamp}
            strokeOpacity={0.9}
            stroke="var(--an-accent)"
            fill="var(--an-accent)"
            fillOpacity={0.13}
          />
          )}
        </LineChart>
      </Box>
      <Box style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        <Text className="analysis-label">{fromLabel}</Text>
        <Text className="analysis-label" style={{ color: "#4a4f58" }}>
          {t("ui.logs.chart-drag-hint")}
        </Text>
        <Text className="analysis-label">{toLabel}</Text>
      </Box>
    </Box>
  );
};
