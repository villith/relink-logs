import { Box, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { MetricRow } from "./metrics/types";
import type { SelectorPins } from "./selectorOptions";

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
};

/** The one table every metric renders through.
 *
 * Bars scale against the LARGEST row rather than the total: at the abilities
 * level the rows are a subset of one player's damage, so a share-of-total bar
 * would render every row as a sliver. */
export const MetricTable = ({ rows, columnKeys, onPin, renderLabel }: MetricTableProps) => {
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
    <Stack gap={2}>
      <Group gap="xs" px="xs">
        <Text size="xs" c="dimmed" style={{ flex: 1 }} />
        {columnKeys.map((key) => (
          <Text key={key} size="xs" c="dimmed" tt="uppercase" w={70} ta="right">
            {t(key)}
          </Text>
        ))}
      </Group>

      {rows.map((row) => (
        <UnstyledButton
          key={row.key}
          onClick={() => row.pinOnClick && onPin(row.pinOnClick)}
          style={{ cursor: row.pinOnClick ? "pointer" : "default" }}
        >
          <Group gap="xs" px="xs" wrap="nowrap">
            <Box style={{ flex: 1, position: "relative" }}>
              <Box
                data-metric-bar
                style={{
                  // largest === 0 when every row is zero (a fight with no stun,
                  // say). Guarding here keeps those rows visible at zero width
                  // instead of rendering NaN.
                  width: largest === 0 ? "0%" : `${(row.value / largest) * 100}%`,
                  height: 18,
                  borderRadius: 3,
                  background: "var(--mantine-color-blue-7)",
                  position: "absolute",
                  inset: 0,
                }}
              />
              <Text size="sm" style={{ position: "relative" }}>
                {renderLabel ? renderLabel(row) : row.label}
              </Text>
            </Box>
            {row.columns.map((value, index) => (
              <Text key={index} size="sm" w={70} ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                {value}
              </Text>
            ))}
          </Group>
        </UnstyledButton>
      ))}
    </Stack>
  );
};
