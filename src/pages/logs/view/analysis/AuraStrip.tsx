import { ActionIcon, Box, Text, UnstyledButton } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type AuraChip = {
  /** The full aura value this chip selects (`src:status:…`/`tgt:status:…`). */
  aura: string;
  label: string;
  /** Uptime within the current chart window, 0–100 (already rounded). */
  uptimePercent: number;
  selected: boolean;
};

export type AuraStripProps = {
  /** "Source auras:" or "Target auras:" — which pinned actor the chips hold. */
  titleKey: string;
  chips: AuraChip[];
  onSelect: (aura: string) => void;
  onClear: () => void;
};

/** One row of aura chips — WCL's Source/Target Auras Filter. Selecting a chip
 * restricts the damage view to the windows the effect was active on the
 * pinned actor; the selected chip carries the ✕ that clears it (the §1.2
 * visibility rule: a live filter must be visible and dismissible where it was
 * set). Clicking the selected chip again also clears — a filter must never
 * need a trip elsewhere to undo.
 *
 * Renders nothing with no chips: the strip only exists while the actor pin
 * that anchors it does, and an empty row of chrome would say nothing. */
export const AuraStrip = ({ titleKey, chips, onSelect, onClear }: AuraStripProps) => {
  const { t } = useTranslation();

  if (chips.length === 0) return null;

  return (
    <Box className="analysis-aura-strip">
      <Text className="analysis-label">{t(titleKey)}</Text>
      {chips.map((chip) => (
        <Box key={chip.aura} className={`analysis-aura-chip${chip.selected ? " analysis-aura-chip-selected" : ""}`}>
          <UnstyledButton
            className="analysis-aura-chip-button"
            aria-pressed={chip.selected}
            onClick={() => (chip.selected ? onClear() : onSelect(chip.aura))}
          >
            <span className="analysis-aura-chip-name">{chip.label}</span>
            <span className="analysis-num analysis-aura-chip-uptime">{`${chip.uptimePercent}%`}</span>
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
