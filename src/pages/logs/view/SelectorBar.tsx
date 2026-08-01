import { ActionIcon, Badge, Group, MultiSelect, Select, Stack, Text } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { SelectorPins } from "./selectorOptions";

export type LabelledOption = { value: string; label: string };

export type SelectorBarProps = {
  options: { sources: LabelledOption[]; targets: LabelledOption[]; abilities: LabelledOption[] };
  pins: SelectorPins;
  onChange: (pins: SelectorPins) => void;
  /** Formatted window, or null for the full fight. */
  windowLabel: string | null;
  onClearWindow: () => void;
};

/** The three pins plus the window readout.
 *
 * Sized to content and left-aligned rather than stretched across the window:
 * a selector that spans the viewport reads as a search field, not a filter.
 * The window is deliberately NOT a selector — it is set by dragging the chart
 * and only cleared here. */
export const SelectorBar = ({ options, pins, onChange, windowLabel, onClearWindow }: SelectorBarProps) => {
  const { t } = useTranslation();

  const field = (label: string, control: React.ReactNode) => (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      {control}
    </Stack>
  );

  return (
    <Group gap="sm" align="flex-end" wrap="wrap">
      {field(
        t("ui.logs.selector-source"),
        <Select
          w={170}
          data={options.sources}
          value={pins.source === null ? null : String(pins.source)}
          placeholder={t("ui.logs.selector-all-friendlies")}
          clearable
          searchable
          onChange={(value) => onChange({ ...pins, source: value === null ? null : Number(value) })}
        />
      )}
      {field(
        t("ui.logs.selector-target"),
        <MultiSelect
          w={200}
          data={options.targets}
          value={pins.targetIds.map(String)}
          placeholder={t("ui.logs.selector-all-enemies")}
          clearable
          searchable
          onChange={(values) => onChange({ ...pins, targetIds: values.map(Number) })}
        />
      )}
      {field(
        t("ui.logs.selector-ability"),
        <Select
          w={210}
          data={options.abilities}
          value={pins.ability}
          placeholder={t("ui.logs.selector-all-abilities")}
          clearable
          searchable
          onChange={(value) => onChange({ ...pins, ability: value })}
        />
      )}
      {windowLabel !== null && (
        <Badge
          size="lg"
          radius="sm"
          variant="light"
          color="yellow"
          style={{ textTransform: "none", fontVariantNumeric: "tabular-nums" }}
          rightSection={
            <ActionIcon
              size="xs"
              variant="transparent"
              color="yellow"
              aria-label={t("ui.logs.window-reset")}
              title={t("ui.logs.window-reset")}
              onClick={onClearWindow}
            >
              <X size={12} weight="bold" />
            </ActionIcon>
          }
        >
          {windowLabel}
        </Badge>
      )}
    </Group>
  );
};
