import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { Label } from "@/components/ui/Label";

import { HOVER_PANEL_CLASS } from "../analysis/HoverCard";
import { capCardRows, selectCapUp, type CapHit, type CapRow, type PlayerCapUp } from "./capBreakdown";

const format = (row: CapRow, locale: string): string => {
  switch (row.kind) {
    case "count":
      return row.value.toLocaleString(locale);
    case "rate":
      return row.value.toLocaleString(locale, { maximumFractionDigits: 2 });
    case "percent":
      return `${row.value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
    case "multiplier":
      return `x${row.value.toLocaleString(locale, { minimumFractionDigits: 3 })}`;
  }
};

/** The Amount cell. A damage row's amount is the END of a calculation the log
 * already records the inputs to, so hovering it explains itself.
 *
 * Rows with nothing to explain render the bare number and open no card at all:
 * a non-damage row has no cap, and a damage row from a log predating the
 * capture yields only the `damage` row, which would restate the cell. An empty
 * or one-row card would imply the data is missing rather than inapplicable. */
export const AmountCell = ({
  amount,
  capHit,
  playerCapUp,
  width,
}: {
  amount: number | null;
  capHit: CapHit | null;
  /** The acting player's cap-up totals, or undefined when the log predates the
   * capture — in which case the card falls back to its Stage-1 rows rather than
   * showing a cap-up block it cannot fill. */
  playerCapUp?: PlayerCapUp;
  width: number;
}) => {
  const { t, i18n } = useTranslation();
  const rows = useMemo(() => {
    if (capHit === null) return [];
    const total = selectCapUp(playerCapUp, capHit.class_flags);
    // No derived sources yet, so the whole total reports as unaccounted. That
    // is the honest starting point, and every source that lands shrinks it.
    return capCardRows(capHit, total === null ? undefined : { totalCapUp: total, terms: [] });
  }, [capHit, playerCapUp]);
  const shows = rows.length > 1;

  // Memoized because `CursorCard` re-renders on every committed cursor frame
  // and only its own position should change; see its `content` prop.
  const content = useMemo(
    () => (
      <Box className="px-[9px] py-1.5">
        {rows.map((row) => (
          <Box key={row.key} className="flex items-baseline justify-between gap-4" data-cap-row={row.key}>
            <Label>{t(row.labelKey)}</Label>
            <Text className="text-sm text-white" style={{ fontVariantNumeric: "tabular-nums" }}>
              {format(row, i18n.language)}
            </Text>
          </Box>
        ))}
      </Box>
    ),
    [rows, t, i18n.language]
  );

  const cell = (
    <Text size="xs" ta="right" data-cell="amount" style={{ fontVariantNumeric: "tabular-nums" }}>
      {amount === null ? "" : amount.toLocaleString(i18n.language)}
    </Text>
  );

  return (
    <Box w={width}>
      {shows ? (
        // The same surface as the metric and aura cards (`HOVER_PANEL_CLASS`):
        // one view must not teach two kinds of tooltip. Sized to its content
        // rather than to the metric card's width floor — six label/value pairs
        // do not need it.
        //
        // Grows LEFT: Amount is the rightmost column, so there is no room to
        // its right and the default placement would only park the card against
        // the window edge.
        <CursorCard
          content={content}
          testId="cap-card"
          className={HOVER_PANEL_CLASS}
          placement="top-left"
          style={{ maxWidth: 280 }}
        >
          {cell}
        </CursorCard>
      ) : (
        cell
      )}
    </Box>
  );
};
