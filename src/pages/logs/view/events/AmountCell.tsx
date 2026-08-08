import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";

import { capCardRows, type CapHit, type CapRow } from "./capBreakdown";

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
 * Rows with nothing to explain render the bare number with no card at all: a
 * non-damage row has no cap, and a damage row from a log predating the capture
 * yields only the `damage` row, which would restate the cell. An empty or
 * one-row card would imply the data is missing rather than inapplicable. */
export const AmountCell = ({
  amount,
  capHit,
  width,
}: {
  amount: number | null;
  capHit: CapHit | null;
  width: number;
}) => {
  const { t, i18n } = useTranslation();
  const rows = useMemo(() => (capHit === null ? [] : capCardRows(capHit)), [capHit]);
  const shows = rows.length > 1;

  // Memoized because `CursorCard` re-renders on every committed cursor frame
  // and only its own position should change; see its `content` prop.
  const content = useMemo(
    () =>
      rows.map((row) => (
        <Text key={row.key} size="xs" data-cap-row={row.key}>
          {t(row.labelKey)} {format(row, i18n.language)}
        </Text>
      )),
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
        <CursorCard content={content} testId="cap-card" style={{ padding: 8 }}>
          {cell}
        </CursorCard>
      ) : (
        cell
      )}
    </Box>
  );
};
