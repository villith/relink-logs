import { ActionIcon, Box, Text, UnstyledButton } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import "./analysis.css";
import { WINDOW_BAND_COLOR } from "./chartWindowBands";
import type { WindowChip } from "./windowChips";

export type WindowStripProps = {
  chips: WindowChip[];
  onSelect: (win: string) => void;
  onClear: () => void;
};

/** One row of battle-window chips — the window filter's whole UI. Selecting a
 * chip restricts every tab to time inside that window (or that kind's
 * windows); the selected chip carries the ✕ that clears it, and clicking it
 * again also clears — the aura strip's exact interaction. Renders nothing
 * when the log has no windows. */
export const WindowStrip = ({ chips, onSelect, onClear }: WindowStripProps) => {
  const { t } = useTranslation();

  if (chips.length === 0) return null;

  return (
    <Box className="analysis-aura-strip">
      <Text className="analysis-label">{t("ui.logs.window-strip-title")}</Text>
      {chips.map((chip) => (
        <Box key={chip.value} className={`analysis-aura-chip${chip.selected ? " analysis-aura-chip-selected" : ""}`}>
          <UnstyledButton
            className="analysis-aura-chip-button"
            aria-pressed={chip.selected}
            // A per-window chip's visible label is a bare range ("10-20"),
            // naming no kind — the kind chip beside it already carries the
            // kind's name in its label, so it needs no override here.
            {...(chip.durationLabel !== null ? { "aria-label": `${chip.kindLabel} ${chip.label}` } : {})}
            onClick={() => (chip.selected ? onClear() : onSelect(chip.value))}
          >
            <span
              className="analysis-window-chip-swatch"
              style={{ backgroundColor: WINDOW_BAND_COLOR[chip.kind] }}
              aria-hidden
            />
            <span className="analysis-aura-chip-name">{chip.label}</span>
            {chip.durationLabel !== null && (
              <span className="analysis-num analysis-aura-chip-uptime">{chip.durationLabel}</span>
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
