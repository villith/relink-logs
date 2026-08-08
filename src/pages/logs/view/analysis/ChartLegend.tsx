import { Box, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartToggle, TOGGLE_CLASS } from "./ChartToggle";

/** Carries no colour: each site states its own, because two colour utilities on
 * one element are decided by stylesheet order rather than by which was written
 * last. */
const NAME_CLASS = "text-xs leading-[1.4]";

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
    <Box className="flex flex-wrap gap-x-3 gap-y-0.5 pb-0.5 pt-1" aria-label={t("ui.logs.chart-legend-label")}>
      {listed.map((entry) => (
        <ChartToggle
          key={entry.key}
          dataKey={entry.key}
          label={entry.label}
          color={entry.color}
          shown={!hidden.has(entry.key)}
          onToggle={() => onToggle(entry.key)}
        />
      ))}
      {tailCount > 0 && (
        // In the legend's own flow rather than beside it, so it wraps with the
        // entries it expands. It carries no swatch — it names no series — and
        // reads as the quieter thing it is.
        <UnstyledButton
          className={TOGGLE_CLASS}
          aria-expanded={tailShown}
          onClick={() => setTailShown((previous) => !previous)}
        >
          <Text className={`${NAME_CLASS} text-ink-3 underline decoration-dotted underline-offset-2`}>
            {tailShown
              ? t("ui.logs.chart-legend-show-fewer")
              : t("ui.logs.chart-legend-show-more", { count: tailCount })}
          </Text>
        </UnstyledButton>
      )}
    </Box>
  );
};
