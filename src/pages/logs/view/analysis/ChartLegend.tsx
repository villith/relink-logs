import { Box, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type LegendEntry = { key: string; label: string; color: string };

export type ChartLegendProps = {
  entries: LegendEntry[];
  /** Series keys currently hidden from the plot. */
  hidden: Set<string>;
  onToggle: (key: string) => void;
};

/** The chart's legend, in ORDINARY FLOW rather than inside the plot.
 *
 * Mantine renders its legend as a recharts `<Legend>` with a hardcoded
 * `height: 44` (AreaChart.mjs), and recharts lays the plot out beneath exactly
 * that: one row of entries fits, and a second row overflows into the plot.
 * Measured with the 17 bands a drill-down produces, the legend's content ran
 * 46px into the plot. A legend outside the chart cannot overlap it and wraps
 * freely.
 *
 * It also carries the click Mantine 7.6.1 cannot: its own `ChartLegend` wires
 * `onMouseEnter`/`onMouseLeave` to `onHighlight` and nothing else — no click
 * handler, no hidden-series state.
 *
 * A hidden entry is DIMMED, never removed — removing it would leave no way to
 * bring the series back. */
export const ChartLegend = ({ entries, hidden, onToggle }: ChartLegendProps) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;

  return (
    <Box className="analysis-legend" aria-label={t("ui.logs.chart-legend-label")}>
      {entries.map((entry) => {
        const shown = !hidden.has(entry.key);
        return (
          <UnstyledButton
            key={entry.key}
            className="analysis-legend-entry"
            aria-pressed={shown}
            onClick={() => onToggle(entry.key)}
          >
            <Box
              data-legend-swatch
              className="analysis-legend-swatch"
              style={{ backgroundColor: entry.color, opacity: shown ? 1 : 0.25 }}
            />
            <Text className="analysis-legend-name" style={{ opacity: shown ? 1 : 0.45 }}>
              {entry.label}
            </Text>
          </UnstyledButton>
        );
      })}
    </Box>
  );
};

