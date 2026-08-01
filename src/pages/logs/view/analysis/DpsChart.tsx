import { AreaChart, LineChart } from "@mantine/charts";
import { Box, Paper, Text } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
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
  /** i18next key naming what is plotted; follows the metric tabs. */
  labelKey: string;
  /** How a value reads: a humanized amount, or a gauge percentage. */
  format: "amount" | "percent";
  /** Commits a window as bucket indexes RELATIVE TO `data`, or null to clear. */
  onScope: (window: [number, number] | null) => void;
  /** Drawn under the plot as the axis bounds. */
  fromLabel: string;
  toLabel: string;
  /** Stack the series as filled bands instead of drawing them independently.
   *
   * The drill-down levels are a decomposition — a player's damage split by skill
   * group, an ability's split by target — so the bands compose a total that is
   * itself meaningful, and the stack's height keeps showing it. Independent
   * lines are right at the players level, where four players' curves are
   * compared rather than added. */
  stacked?: boolean;
};

// recharts types a tooltip entry as Payload<any, any>, which has no index
// signature; the same `any` escape hatch as DetailCharts' tooltip.
export const ChartTooltip = ({
  label,
  payload,
  format,
  labels,
}: {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
  format: "amount" | "percent";
  /** The series descriptors, so a payload entry can be named. */
  labels: Label;
}) => {
  if (!payload) return null;

  // Mantine hands recharts `name: item.name` — the series KEY, not its label
  // (AreaChart.mjs) — so the payload cannot name itself. Mantine's own legend
  // hides this by looking the key up through `getSeriesLabels`; ours has to do
  // the same, or it prints actor indexes and group keys at the user.
  const labelByKey = new Map(labels.map((series) => [series.name, series.label ?? series.name]));

  // Only what actually landed in this bucket. A stack of 17 skill-group bands
  // is mostly zeroes at any one moment, and listing every one of them buries
  // the few that fired. A zero reads the same on the gauge tab — "0%" says
  // nothing the absent row does not.
  const landed = payload.filter((item) => typeof item.value === "number" && item.value !== 0);

  // Nothing at all: a card holding only a timestamp is worse than no card.
  if (landed.length === 0) return null;

  return (
    <Paper px="md" py="sm" withBorder shadow="md" radius="md">
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {landed.map((item) => {
          const [n, suffix] =
            format === "percent" ? [item.value as number, "%"] : humanizeNumbers(item.value as number);
          return (
            // Keyed by dataKey (the actor index), not name: two players can
            // share a display label, and React drops the duplicate row.
            <Text key={String(item.dataKey)} fz="sm">
              <Text component="span" c={item.color as string}>
                {labelByKey.get(String(item.name)) ?? String(item.name)}
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
export const DpsChart = ({
  data,
  labels,
  labelKey,
  format,
  onScope,
  fromLabel,
  toLabel,
  stacked = false,
}: DpsChartProps) => {
  const { t } = useTranslation();
  const anchor = useRef<number | null>(null);
  const [band, setBand] = useState<[number, number] | null>(null);

  // Series the user has clicked off in the legend. Mantine 7.6.1 cannot do this
  // itself — its legend has no click handler and no hidden state.
  //
  // Hiding a band lowers the stack, so the plot stops showing the player's whole
  // output. That is accepted deliberately: comparing two groups directly is the
  // reason to hide the others.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // The keys the current pins produce. A hidden band must not survive a pin
  // change: under the next player the keys differ, and a set carried across
  // would hide an arbitrary band of a chart the user never touched.
  const seriesKeys = useMemo(() => labels.map((series) => series.name).join(" "), [labels]);
  useEffect(() => setHidden(new Set()), [seriesKeys]);

  const shownSeries = useMemo(() => labels.filter((series) => !hidden.has(series.name)), [labels, hidden]);

  const legendEntries = useMemo(
    () => labels.map((series) => ({ key: series.name, label: series.label ?? series.name, color: series.color })),
    [labels]
  );

  const toggleSeries = (key: string) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const maxIndex = Math.max(0, data.length - 1);
  const at = (index: number | undefined) => (typeof index === "number" ? index : null);

  const end = (last: number | null) => {
    const start = anchor.current;
    anchor.current = null;
    setBand(null);
    if (start === null || last === null) return;
    onScope(windowFromDrag(start, last, maxIndex));
  };

  // recharts' own drag, identical for both chart types — Mantine just forwards
  // it under a different prop name.
  const interaction = {
    margin: { top: 5, right: 5, bottom: 5, left: 5 },
    // Selecting text mid-drag would otherwise fight the gesture.
    style: { userSelect: "none" as const },
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
    // A drag that leaves the plot still has to end, or the next move over it
    // would extend a stale selection.
    onMouseLeave: () => {
      anchor.current = null;
      setBand(null);
    },
  };

  const shared = {
    h: "clamp(190px, 26vh, 380px)",
    data,
    dataKey: "timestamp",
    withDots: false,
    // Ours instead, rendered outside the plot: Mantine's is laid out INSIDE it
    // at a fixed 44px and overlaps it as soon as the entries wrap — see
    // ChartLegend.
    withLegend: false,
    series: shownSeries,
    valueFormatter: (value: number) => {
      if (format === "percent") return `${value}%`;
      const [n, suffix] = humanizeNumbers(value);
      return `${n}${suffix}`;
    },
    yAxisProps: { width: 60 },
    xAxisProps: { interval: "preserveStartEnd" as const },
  };

  // Kept out of `shared`: recharts types `content` against its own tooltip
  // props, and passing it through a plain object loses the contextual typing
  // that makes the destructured label and payload check.
  const tooltip = {
    content: ({ label, payload }: { label?: unknown; payload?: Record<string, any>[] }) => ( // eslint-disable-line
      <ChartTooltip label={String(label ?? "")} payload={payload} format={format} />
    ),
  };

  const scopeBand = band && band[0] !== band[1] && (
    <ReferenceArea
      x1={data[Math.min(band[0], band[1])]?.timestamp}
      x2={data[Math.max(band[0], band[1])]?.timestamp}
      strokeOpacity={0.9}
      stroke="var(--an-accent)"
      fill="var(--an-accent)"
      fillOpacity={0.13}
    />
  );

  return (
    <Box style={{ padding: "10px 16px 8px" }}>
      <Text className="analysis-label" style={{ marginBottom: 5 }}>
        {t(labelKey)}
      </Text>
      {/* Double-click sits on the wrapper, not in `lineChartProps`: recharts'
          CategoricalChartProps has no onDoubleClick, and the wrapper sees the
          same gesture anywhere over the plot. */}
      <Box onDoubleClick={() => onScope(null)}>
        <LineChart
          h="clamp(190px, 26vh, 380px)"
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
      <ChartLegend entries={legendEntries} hidden={hidden} onToggle={toggleSeries} />
      <Box style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        <Text className="analysis-label">{fromLabel}</Text>
        <Text className="analysis-label">{t("ui.logs.chart-drag-hint")}</Text>
        <Text className="analysis-label">{toLabel}</Text>
      </Box>
    </Box>
  );
};
