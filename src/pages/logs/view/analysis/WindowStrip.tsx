import { CHIP_SWATCH_CLASS, ChipStrip, type StripChip } from "./ChipStrip";

import { WINDOW_BAND_COLOR } from "./chartWindowBands";
import type { WindowChip } from "./windowChips";

export type WindowStripProps = {
  chips: WindowChip[];
  onSelect: (win: string) => void;
  onClear: () => void;
};

/** One row of battle-window chips — the window filter's whole UI. Selecting a
 * chip restricts every tab to time inside that window (or that kind's windows).
 * The strip and its select/clear interaction are `ChipStrip`, the same as the
 * aura strip; what is window-specific is the kind swatch, the duration figure
 * and the accessible name. */
export const WindowStrip = ({ chips, onSelect, onClear }: WindowStripProps) => (
  <ChipStrip
    titleKey="ui.logs.window-strip-title"
    chips={chips.map(
      (chip): StripChip => ({
        value: chip.value,
        label: chip.label,
        selected: chip.selected,
        leading: (
          <span className={CHIP_SWATCH_CLASS} style={{ backgroundColor: WINDOW_BAND_COLOR[chip.kind] }} aria-hidden />
        ),
        figure: chip.durationLabel,
        // A per-window chip's visible label is a bare range ("10-20"), naming
        // no kind — the kind chip beside it already carries the kind's name in
        // its label, so it needs no override.
        ariaLabel: chip.durationLabel === null ? undefined : `${chip.kindLabel} ${chip.label}`,
      })
    )}
    onSelect={onSelect}
    onClear={onClear}
  />
);
