import { ActionIcon, Box, MultiSelect, Select, Text } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { SelectorPins } from "../selectorOptions";

import "./analysis.css";

export type LabelledOption = { value: string; label: string };

export type PinBarProps = {
  options: { sources: LabelledOption[]; targets: LabelledOption[]; abilities: LabelledOption[] };
  pins: SelectorPins;
  onChange: (pins: SelectorPins) => void;
  /** Formatted window, or null for the full fight. */
  windowLabel: string | null;
  /** The whole fight's duration, so a scoped window stays located in it. */
  fullLabel: string;
  onClearWindow: () => void;
};

/** The three pins and the window readout.
 *
 * No label in front of each selector: the placeholder already names the
 * dimension — "All enemies" cannot be mistaken for a source — so a label
 * repeats it. Left-to-right order carries the rest.
 *
 * The window is deliberately not a selector. It is set by dragging the chart
 * and only cleared here. */
export const PinBar = ({ options, pins, onChange, windowLabel, fullLabel, onClearWindow }: PinBarProps) => {
  const { t } = useTranslation();

  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--an-line)",
        flexWrap: "wrap",
      }}
    >
      <Select
        w={190}
        size="xs"
        data={options.sources}
        value={pins.source === null ? null : String(pins.source)}
        placeholder={t("ui.logs.selector-all-friendlies")}
        aria-label={t("ui.logs.selector-source")}
        clearable
        searchable
        onChange={(value) => onChange({ ...pins, source: value === null ? null : Number(value) })}
      />
      <MultiSelect
        w={210}
        size="xs"
        // Mantine's xs MultiSelect wraps its value in a pill container, which
        // makes it 33px against the Selects' 30px and misaligns the row.
        styles={{ input: { minHeight: 30, height: 30 } }}
        data={options.targets}
        value={pins.targetIds.map(String)}
        placeholder={t("ui.logs.selector-all-enemies")}
        aria-label={t("ui.logs.selector-target")}
        clearable
        searchable
        onChange={(values) => onChange({ ...pins, targetIds: values.map(Number) })}
      />
      <Select
        w={220}
        size="xs"
        data={options.abilities}
        value={pins.ability}
        placeholder={t("ui.logs.selector-all-abilities")}
        aria-label={t("ui.logs.selector-ability")}
        clearable
        searchable
        onChange={(value) => onChange({ ...pins, ability: value })}
      />
      {windowLabel !== null && (
        <Box
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 6px 0 11px",
            borderRadius: 4,
            border: "1px solid var(--an-accent)",
            backgroundColor: "rgba(0, 184, 217, 0.09)",
          }}
        >
          <Text className="analysis-num" style={{ fontSize: 12.5, color: "var(--an-accent)" }}>
            {windowLabel}
          </Text>
          {/* `window-of` next door is Classic's full sentence and interpolates
              both ends; this chip already states the window beside it, so it
              needs the shorter "of {{total}}". */}
          <Text style={{ fontSize: 11, color: "var(--an-ink-3)" }}>
            {t("ui.logs.window-within", { total: fullLabel })}
          </Text>
          {/* sm, not xs: this is the only control that clears a window, and xs
              measured 18x18 against WCAG 2.2 SC 2.5.8's 24x24. */}
          <ActionIcon
            size="sm"
            variant="transparent"
            color="gray"
            aria-label={t("ui.logs.window-reset")}
            title={t("ui.logs.window-reset")}
            onClick={onClearWindow}
          >
            <X size={12} weight="bold" />
          </ActionIcon>
        </Box>
      )}
    </Box>
  );
};
