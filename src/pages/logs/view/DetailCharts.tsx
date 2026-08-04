import { AreaChart, LineChart } from "@mantine/charts";
import { Group, Paper, Text, UnstyledButton } from "@mantine/core";
import { t } from "i18next";
import { memo } from "react";

import { humanizeNumbers } from "@/utils";

/** One series per charted player, as the DPS chart's `series` prop wants it. */
export type Label = {
  name: string;
  partySlotIndex: number;
  label?: string;
  color: string;
  strokeDasharray?: string;
}[];

interface ChartTooltipProps {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
  /** Overrides the plain thousands-separated rendering (the HP chart shows percentages).
   * Mantine's own `valueFormatter` cannot reach a custom `content`, so it is passed here. */
  formatValue?: (value: number) => string;
}

export const ChartTooltip = ({ label, payload, formatValue }: ChartTooltipProps) => {
  if (!payload) return null;

  const format = formatValue ?? ((value: number) => new Intl.NumberFormat("en-US").format(value));

  return (
    <Paper px="md" py="sm" withBorder shadow="md" radius="md">
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {/* A null datapoint means "no data here" (e.g. an HP pool that hasn't
          spawned yet or is already dead) — not a zero; leave it out. */}
      {payload
        .filter((item) => item.value !== null && item.value !== undefined)
        .map(
          (
            item: any // eslint-disable-line
          ) => (
            <Text key={item.name} fz="sm">
              <Text component="span" c={item.color}>
                {item.name === "party" ? t("ui.logs.damage-per-second") : item.name}
              </Text>
              : {format(item.value)}
            </Text>
          )
        )}
    </Paper>
  );
};

// Chart buckets are one second wide (the backend's DPS_INTERVAL), so a bucket
// index IS the elapsed second. Every bucket-index↔milliseconds conversion must
// go through this constant — a silent `* 1000` breaks if the width changes.
export const DPS_BUCKET_MS = 1000;

// DPS points are smoothed with a trailing moving average this many seconds wide.
export const DPS_SMOOTHING_WINDOW = 10;

// Chart geometry pinned so the overview brush can span exactly the plot area:
// recharts margin (5px each side) + y-axis width, matched by the brush insets.
export const CHART_MARGIN = 5;
export const CHART_Y_AXIS_WIDTH = 60;

export type ChartDatapoint = {
  timestamp?: string;
  party?: number;
} & { [key: string]: number };

export type HpDatapoint = { timestamp?: string; [key: string]: string | number | null | undefined };

/** Fixed categorical order for the enemy HP lines: the boss (largest pool) is
 * always the first, red; extra pools (summon waves count individually, up to
 * the backend's 12-series cap) follow in pool-size order. */
export const HP_SERIES_COLORS = [
  "red.6",
  "cyan.6",
  "yellow.6",
  "grape.6",
  "lime.6",
  "indigo.6",
  "orange.6",
  "teal.6",
  "pink.6",
  "blue.6",
  "green.6",
  "violet.6",
];

export const mantineColorVar = (color: string) => `var(--mantine-color-${color.replace(".", "-")})`;

/** The zoomable detail charts (enemy HP% strip + per-player DPS). Memoized so
 * brush drags — which re-render the page on every pointer move — skip these
 * expensive recharts trees until a window is actually committed.
 *
 * Drawn by both the classic and analysis views, so a change here changes both. */
export const DetailCharts = memo(function DetailCharts({
  data,
  hpData,
  hpSeries,
  hiddenHpSeries,
  onToggleHpSeries,
  labels,
}: {
  data: ChartDatapoint[];
  hpData: HpDatapoint[];
  hpSeries: { name: string; color: string }[];
  hiddenHpSeries: Set<string>;
  onToggleHpSeries: (name: string) => void;
  labels: Label;
}) {
  // Our own legend chips instead of the recharts legend: they toggle lines
  // on/off, and they wrap ABOVE the chart instead of into the plot area on
  // summon-heavy fights. Hidden series leave the plot and the tooltip alike.
  const visibleHpSeries = hpSeries.filter((series) => !hiddenHpSeries.has(series.name));

  return (
    <>
      {hpSeries.length > 0 && (
        <>
          <Group gap="xs" align="center">
            <Text size="sm">{t("ui.logs.enemy-hp")}</Text>
            {hpSeries.length > 1 &&
              hpSeries.map((series) => {
                const hidden = hiddenHpSeries.has(series.name);
                return (
                  <UnstyledButton
                    key={series.name}
                    onClick={() => onToggleHpSeries(series.name)}
                    style={{ opacity: hidden ? 0.4 : 1 }}
                  >
                    <Group gap={4} wrap="nowrap">
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          flexShrink: 0,
                          display: "inline-block",
                          background: mantineColorVar(series.color),
                        }}
                      />
                      <Text size="xs" td={hidden ? "line-through" : undefined}>
                        {series.name}
                      </Text>
                    </Group>
                  </UnstyledButton>
                );
              })}
          </Group>
          <LineChart
            h={hpSeries.length > 1 ? 180 : 120}
            data={hpData}
            dataKey="timestamp"
            withDots={false}
            connectNulls
            series={visibleHpSeries}
            yAxisProps={{ domain: [0, 100], width: CHART_Y_AXIS_WIDTH }}
            xAxisProps={{ interval: "preserveStartEnd" }}
            valueFormatter={(value) => `${value.toFixed(1)}%`}
            lineChartProps={{
              syncId: "quest-details",
              margin: { top: CHART_MARGIN, right: CHART_MARGIN, bottom: CHART_MARGIN, left: CHART_MARGIN },
            }}
            tooltipProps={{
              // The synced DPS tooltip renders at the same instant right below;
              // a tall HP tooltip must stack above it, not slide behind it.
              wrapperStyle: { zIndex: 20 },
              // Mantine spreads `tooltipProps` AFTER its own `content`, so this replaces
              // the built-in tooltip outright and `valueFormatter` never reaches it — the
              // formatter above only styles the y-axis ticks. Format here too, or the
              // percentages render as bare floats next to raw DPS numbers.
              content: ({ label, payload }) => (
                <ChartTooltip label={label} payload={payload} formatValue={(value) => `${value.toFixed(1)}%`} />
              ),
            }}
          />
        </>
      )}
      <Text size="sm">{t("ui.logs.damage-per-second")}</Text>
      <LineChart
        h={400}
        data={data}
        dataKey="timestamp"
        withDots={false}
        withLegend
        series={labels}
        valueFormatter={(value) => {
          const [num, suffix] = humanizeNumbers(value);
          return `${num}${suffix}`;
        }}
        yAxisProps={{ width: CHART_Y_AXIS_WIDTH }}
        xAxisProps={{ interval: "preserveStartEnd" }}
        lineChartProps={{
          syncId: "quest-details",
          margin: { top: CHART_MARGIN, right: CHART_MARGIN, bottom: CHART_MARGIN, left: CHART_MARGIN },
        }}
        tooltipProps={{
          wrapperStyle: { zIndex: 10 }, // below the HP tooltip when they meet
          content: ({ label, payload }) => <ChartTooltip label={label} payload={payload} />,
        }}
      />
    </>
  );
});

/** The full-fight context strip the brush rides on: a quiet party-DPS area.
 * Memoized for the same drag-performance reason as the detail charts.
 *
 * Classic-only: the analysis view scopes its window by dragging the plot
 * itself, so it has no brush and needs no strip to ride on. */
export const OverviewChart = memo(function OverviewChart({ data }: { data: { timestamp?: string; party?: number }[] }) {
  return (
    <AreaChart
      h={56}
      data={data}
      dataKey="timestamp"
      series={[{ name: "party", color: "gray.6" }]}
      withDots={false}
      withXAxis={false}
      withYAxis={false}
      withTooltip={false}
      gridAxis="none"
      fillOpacity={0.4}
      areaChartProps={{ margin: { top: 2, right: 0, bottom: 0, left: 0 } }}
    />
  );
});

/** Dims the parts of the overview strip outside the selected window; follows
 * the handles live during a drag. */
export const brushShade = (side: "left" | "right", widthPercent: number): React.CSSProperties => ({
  position: "absolute",
  top: 0,
  bottom: 0,
  [side]: 0,
  width: `${Math.max(0, Math.min(100, widthPercent))}%`,
  background: "rgba(10, 10, 10, 0.55)",
  pointerEvents: "none",
});
