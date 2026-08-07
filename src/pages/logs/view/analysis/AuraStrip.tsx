import { ChipStrip, type StripChip } from "./ChipStrip";

import "./analysis.css";

export type AuraChip = {
  /** The full aura value this chip selects (`src:status:…`/`tgt:status:…`). */
  aura: string;
  label: string;
  /** Uptime within the current chart window, 0–100 (already rounded). */
  uptimePercent: number;
  selected: boolean;
  /** The effect's art, resolved by the chip builder the same way the effects
   * table resolves its rows' — undefined is the honest state for the ~90
   * internal effects that have none. */
  iconUrl?: string;
};

export type AuraStripProps = {
  /** "Source auras:" or "Target auras:" — which pinned actor the chips hold. */
  titleKey: string;
  chips: AuraChip[];
  onSelect: (aura: string) => void;
  onClear: () => void;
};

/** One row of aura chips — WCL's Source/Target Auras Filter. Selecting a chip
 * restricts the damage view to the windows the effect was active on the pinned
 * actor. The strip itself, and the select/clear interaction, is `ChipStrip`;
 * what is aura-specific is only the effect art and the uptime figure. */
export const AuraStrip = ({ titleKey, chips, onSelect, onClear }: AuraStripProps) => (
  <ChipStrip
    titleKey={titleKey}
    chips={chips.map(
      (chip): StripChip => ({
        value: chip.aura,
        label: chip.label,
        selected: chip.selected,
        leading: chip.iconUrl && <img className="analysis-row-icon" src={chip.iconUrl} alt="" />,
        figure: `${chip.uptimePercent}%`,
      })
    )}
    onSelect={onSelect}
    onClear={onClear}
  />
);
