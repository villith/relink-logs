import { ActionIcon, Box, UnstyledButton } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Figure } from "@/components/ui/Figure";
import { Label } from "@/components/ui/Label";
import { Strip } from "@/components/ui/Strip";

/** The chip anatomy, shared with the events stream's kind filters — the same
 * control in a different strip, and two spellings of it would drift. */
export const CHIP_CLASS = "inline-flex h-chip items-center rounded-sm border border-line-strong bg-panel";
export const CHIP_SELECTED_CLASS = "border-accent bg-accent-soft pr-0.5";
export const CHIP_BUTTON_CLASS = "inline-flex h-full cursor-pointer items-center gap-1.5 px-2 text-sm text-ink-2";
export const CHIP_BUTTON_SELECTED_CLASS = "pr-0.5 text-ink";
/** A window kind's colour block, before the label. */
export const CHIP_SWATCH_CLASS = "inline-block size-swatch shrink-0 rounded-xs";

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
    <Strip rule="top" wrap>
      <Label>{t(titleKey)}</Label>
      {chips.map((chip) => (
        <Box key={chip.value} className={[CHIP_CLASS, chip.selected ? CHIP_SELECTED_CLASS : ""].join(" ")}>
          <UnstyledButton
            className={[CHIP_BUTTON_CLASS, chip.selected ? CHIP_BUTTON_SELECTED_CLASS : ""].join(" ")}
            aria-pressed={chip.selected}
            {...(chip.ariaLabel === undefined ? {} : { "aria-label": chip.ariaLabel })}
            onClick={() => (chip.selected ? onClear() : onSelect(chip.value))}
          >
            {chip.leading}
            <span>{chip.label}</span>
            {chip.figure !== null && chip.figure !== undefined && (
              <Figure data-chip-figure size="xs" tone="dim">
                {chip.figure}
              </Figure>
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
    </Strip>
  );
};
