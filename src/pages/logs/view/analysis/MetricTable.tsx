import { Box, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import { HoverCard, type CardSection } from "./HoverCard";
import "./analysis.css";

export type MetricTableProps = {
  rows: MetricRow[];
  /** i18next keys for the numeric columns, from the active descriptor. */
  columnKeys: string[];
  onPin: (pins: Partial<SelectorPins>) => void;
  /** Turns a row's raw `label` into what is drawn — a player name honouring
   * streamer mode, or a translated skill name. Injected because that lookup
   * needs i18n and the settings store, which would otherwise make this table
   * untestable without both. Defaults to the raw label. */
  renderLabel?: (row: MetricRow) => React.ReactNode;
  /** Resolves a row's bar colour from its `colorSlot`. Injected for the same
   * reason as `renderLabel`: the palette lives in the settings store. */
  rowColor?: (row: MetricRow) => string;
  /** i18next key naming what a row currently represents. */
  rowsLabelKey?: string;
  /** The hover card's sections for one row, or null for no card. Injected
   * because the breakdown needs translated names and the settings store. */
  rowSections?: (row: MetricRow) => CardSection[] | null;
};

const FALLBACK_COLOR = "var(--an-ink-3)";

/** The one table every metric renders through.
 *
 * The bar is the row: a full-height background fill with the text on it, in the
 * row's party-slot colour so the same player is the same colour here and in the
 * chart above.
 *
 * Bars scale against the LARGEST row rather than the total: at the abilities
 * level the rows are a subset of one player's damage, so a share-of-total bar
 * would render every row as a sliver. */
export const MetricTable = ({
  rows,
  columnKeys,
  onPin,
  renderLabel,
  rowColor,
  rowsLabelKey,
  rowSections,
}: MetricTableProps) => {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="lg">
        {t("ui.logs.no-rows")}
      </Text>
    );
  }

  const largest = Math.max(...rows.map((row) => row.value));

  return (
    <Box>
      <Box className="analysis-head">
        <Text className="analysis-label" style={{ flex: 1 }}>
          {rowsLabelKey ? t(rowsLabelKey) : ""}
        </Text>
        {columnKeys.map((key) => (
          <Text key={key} className="analysis-label analysis-cell">
            {t(key)}
          </Text>
        ))}
      </Box>

      {rows.map((row, index) => {
        const button = (
          <UnstyledButton
            className={`analysis-row${row.pinOnClick ? " analysis-row-pinnable" : ""}`}
            onClick={() => row.pinOnClick && onPin(row.pinOnClick)}
          >
            <Box
              data-metric-bar
              className="analysis-bar"
              style={{
                // largest === 0 when every row is zero (a fight with no stun,
                // say). Guarding here keeps those rows visible at zero width
                // instead of rendering NaN.
                width: largest === 0 ? "0%" : `${(row.value / largest) * 100}%`,
                backgroundColor: rowColor ? rowColor(row) : FALLBACK_COLOR,
              }}
            />
            <Text className="analysis-rank">{index + 1}</Text>
            <Text className="analysis-name">{renderLabel ? renderLabel(row) : row.label}</Text>
            {row.columns.map((value, columnIndex) => (
              <Text key={columnIndex} className={`analysis-cell${columnIndex === 0 ? "" : " analysis-cell-muted"}`}>
                {value}
              </Text>
            ))}
          </UnstyledButton>
        );

        // The key moves off the button and onto whichever element is the list
        // child: HoverCard clones its child and would otherwise lose it.
        const sections = rowSections?.(row);
        if (!sections || sections.length === 0) return <Box key={row.key}>{button}</Box>;

        return (
          <HoverCard key={row.key} sections={sections}>
            {button}
          </HoverCard>
        );
      })}
    </Box>
  );
};
