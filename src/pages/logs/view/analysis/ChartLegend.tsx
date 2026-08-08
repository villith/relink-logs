import { Box, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type LegendEntry = {
  key: string;
  label: string;
  color: string;
  /** Ranked past the chart's band cap: plotted only once switched on, and
   * folded out of the legend at rest behind the show-more control. A busy
   * fight ranks 40+ abilities, and listing every one of them at rest would
   * wrap the legend further down the page than the plot is tall. */
  tail?: boolean;
};

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
 * bring the series back. `tail` entries are the exception at REST only: they
 * fold behind the show-more control, and a tail band the user has switched on
 * stays listed either way, or the plot would draw a colour its legend does not
 * explain. */
export const ChartLegend = ({ entries, hidden, onToggle }: ChartLegendProps) => {
  const { t } = useTranslation();
  // Component-local, and deliberately not reset with the hidden set: unfolding
  // the list is a way of READING the chart, not a property of one pin's bands.
  const [tailShown, setTailShown] = useState(false);
  if (entries.length === 0) return null;

  const tailCount = entries.filter((entry) => entry.tail).length;
  // A tail band that is being PLOTTED is listed whatever the fold says.
  const listed = entries.filter((entry) => !entry.tail || tailShown || !hidden.has(entry.key));

  return (
    <Box className="analysis-legend" aria-label={t("ui.logs.chart-legend-label")}>
      {listed.map((entry) => {
        const shown = !hidden.has(entry.key);
        return (
          <UnstyledButton
            key={entry.key}
            data-legend-key={entry.key}
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
      {tailCount > 0 && (
        <UnstyledButton
          className="analysis-legend-entry analysis-legend-more"
          aria-expanded={tailShown}
          onClick={() => setTailShown((previous) => !previous)}
        >
          <Text className="analysis-legend-name">
            {tailShown
              ? t("ui.logs.chart-legend-show-fewer")
              : t("ui.logs.chart-legend-show-more", { count: tailCount })}
          </Text>
        </UnstyledButton>
      )}
    </Box>
  );
};
