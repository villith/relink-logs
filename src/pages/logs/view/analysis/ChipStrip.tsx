import { ActionIcon, Box, Text, UnstyledButton } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type StripChip = {
  /** Identity, and the value the strip reports back on select. */
  value: string;
  label: string;
  selected: boolean;
  /** Drawn before the label — the effect's art, or the window kind's swatch.
   * Omitted is the honest state for the ~90 internal effects with no art. */
  leading?: ReactNode;
  /** Drawn after the label, right-aligned: an uptime percent or a duration.
   * Null draws nothing, which is what a kind chip wants — its count is already
   * in its label. */
  figure?: string | null;
  /** Overrides the button's accessible name where the visible label alone does
   * not identify the chip (a per-window chip reads "10-20", naming no kind). */
  ariaLabel?: string;
};

export type ChipStripProps = {
  titleKey: string;
  chips: StripChip[];
  onSelect: (value: string) => void;
  onClear: () => void;
};

/** One row of selectable filter chips — the battle-window strip.
 *
 * The selected chip carries the ✕ that clears it (the §1.2 visibility rule: a
 * live filter must be visible and dismissible where it was set), and clicking
 * the selected chip again also clears, so a filter never needs a trip
 * elsewhere to undo.
 *
 * The aura strip was the second caller and no longer is: its chips became art
 * alone (see `AuraStrip`), which leaves nothing for the label, the figure or
 * the ✕ to sit beside. The interaction is the same, so this and that strip
 * must keep answering a click the same way; the LAYOUT is what diverged.
 *
 * Renders nothing with no chips: a strip exists only while what anchors it
 * does, and an empty row of chrome would say nothing.
 */
export const ChipStrip = ({ titleKey, chips, onSelect, onClear }: ChipStripProps) => {
  const { t } = useTranslation();

  if (chips.length === 0) return null;

  return (
    <Box className="analysis-aura-strip">
      <Text className="analysis-label">{t(titleKey)}</Text>
      {chips.map((chip) => (
        <Box key={chip.value} className={`analysis-aura-chip${chip.selected ? " analysis-aura-chip-selected" : ""}`}>
          <UnstyledButton
            className="analysis-aura-chip-button"
            aria-pressed={chip.selected}
            {...(chip.ariaLabel === undefined ? {} : { "aria-label": chip.ariaLabel })}
            onClick={() => (chip.selected ? onClear() : onSelect(chip.value))}
          >
            {chip.leading}
            <span className="analysis-aura-chip-name">{chip.label}</span>
            {chip.figure !== null && chip.figure !== undefined && (
              <span className="analysis-num analysis-aura-chip-uptime">{chip.figure}</span>
            )}
          </UnstyledButton>
          {chip.selected && (
            <ActionIcon
              size="sm"
              variant="transparent"
              color="gray"
              aria-label={t("ui.logs.aura-clear")}
              title={t("ui.logs.aura-clear")}
              onClick={onClear}
            >
              <X size={12} weight="bold" />
            </ActionIcon>
          )}
        </Box>
      ))}
    </Box>
  );
};
