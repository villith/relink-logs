import { Eye, EyeSlash } from "@phosphor-icons/react";
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
  /** Per-row eye toggle, or null where a row has nothing to show. Only the
   * status metrics pass it; absent, no row grows a control and the table keeps
   * the DOM it has. */
  rowToggle?: (row: MetricRow) => { shown: boolean; onToggle: () => void } | null;
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
  rowToggle,
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
    <Box role="table">
      <Box className="analysis-head" role="row">
        <Text className="analysis-label" role="columnheader" style={{ flex: 1 }}>
          {rowsLabelKey ? t(rowsLabelKey) : ""}
        </Text>
        {columnKeys.map((key) => (
          <Text key={key} role="columnheader" className="analysis-label analysis-cell">
            {t(key)}
          </Text>
        ))}
      </Box>

      {rows.map((row) => {
        const toggle = rowToggle?.(row);
        const button = (
          // A div, not a button. The band toggle inside it is a real <button>,
          // and a button may not contain interactive content — the row used to
          // be an UnstyledButton with a focusable role="button" span in it,
          // which is invalid and made the two fight over focus and clicks.
          //
          // Focusable and Enter/Space-activated by hand, which is what the
          // <button> was giving for free: a row in a grid is allowed to take
          // focus, and losing keyboard pinning to fix the nesting would be a
          // poor trade.
          <Box
            role="row"
            className={`analysis-row${row.pinOnClick ? " analysis-row-pinnable" : ""}`}
            tabIndex={row.pinOnClick ? 0 : undefined}
            onClick={() => row.pinOnClick && onPin(row.pinOnClick)}
            onKeyDown={(event: React.KeyboardEvent) => {
              if (!row.pinOnClick || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              onPin(row.pinOnClick);
            }}
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
            {/* A real button now that the row is not one. Still stops
                propagation, so banding a row does not also pin it — including
                on the keyboard, where the row above listens for the same keys. */}
            {toggle && (
              <UnstyledButton
                aria-pressed={toggle.shown}
                aria-label={t("ui.logs.buff-band-toggle")}
                className="analysis-row-toggle"
                style={{ opacity: toggle.shown ? 1 : 0.35 }}
                onClick={(event: React.MouseEvent) => {
                  event.stopPropagation();
                  toggle.onToggle();
                }}
                onKeyDown={(event: React.KeyboardEvent) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.stopPropagation();
                }}
              >
                {toggle.shown ? <Eye size={14} weight="fill" /> : <EyeSlash size={14} />}
              </UnstyledButton>
            )}
            <Text role="cell" className="analysis-name">
              {renderLabel ? renderLabel(row) : row.label}
            </Text>
            {row.columns.map((value, columnIndex) => (
              <Text
                key={columnIndex}
                role="cell"
                className={`analysis-cell${columnIndex === 0 ? "" : " analysis-cell-muted"}`}
              >
                {value}
              </Text>
            ))}
          </Box>
        );

        // The key moves off the row and onto whichever element is the list
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
