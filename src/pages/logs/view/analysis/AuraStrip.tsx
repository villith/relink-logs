import { Box, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";

import { HOVER_PANEL_CLASS } from "./HoverCard";

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

/** One chip's hover card: what the tile itself no longer says.
 *
 * The same panel as the metric hover card (`HOVER_PANEL_CLASS`, and
 * `CursorCard` under it), because a reader should not have to learn two kinds
 * of tooltip in one view. Sized to its content rather than to that card's
 * 300px floor — an effect name and a percentage do not need the width, and a
 * panel three times wider than its text reads as a mis-render. */
const AuraTooltip = ({ label, uptimePercent, children }: AuraChip & { children: React.ReactElement }) => {
  const { t } = useTranslation();

  return (
    <CursorCard
      testId="aura-hover-card"
      className={`analysis-tokens ${HOVER_PANEL_CLASS}`}
      style={{ maxWidth: 280 }}
      content={
        <Box className="analysis-aura-card">
          <Text className="analysis-aura-card-name">{label}</Text>
          <Text className="analysis-label">{t("ui.logs.aura-uptime", { percent: uptimePercent })}</Text>
        </Box>
      }
    >
      {children}
    </CursorCard>
  );
};

/** One row of aura tiles — Warcraft Logs' Source/Target Auras Filter.
 *
 * Selecting a tile restricts the damage view to the windows the effect was
 * active on the pinned actor. The tiles are ART ALONE: a fight holds dozens of
 * effects, and named in full they wrapped the strip several rows deep between
 * the chart and the table. What a tile is, and how long it held, moves into
 * the hover card; the accessible name carries the same thing for a reader who
 * cannot see the art.
 *
 * The tile is also its own clear: clicking the selected one deselects it. It
 * carries no ✕ — beside a 24px square that control would make the selected
 * tile visibly wider than its neighbours and shuffle the whole strip on every
 * click — but the §1.2 rule it served still holds, since the live filter stays
 * visible as the selected tile and dismissible by clicking it.
 *
 * Renders nothing with no chips: a strip exists only while what anchors it
 * does, and an empty row of chrome would say nothing. */
export const AuraStrip = ({ titleKey, chips, onSelect, onClear }: AuraStripProps) => {
  const { t } = useTranslation();

  if (chips.length === 0) return null;

  return (
    <Box className="analysis-aura-strip">
      <Text className="analysis-label">{t(titleKey)}</Text>
      {chips.map((chip) => (
        <AuraTooltip key={chip.aura} {...chip}>
          <UnstyledButton
            className={`analysis-aura-tile${chip.selected ? " analysis-aura-tile-selected" : ""}`}
            aria-pressed={chip.selected}
            // The tile writes nothing, so this is the only name it has.
            aria-label={chip.label}
            onClick={() => (chip.selected ? onClear() : onSelect(chip.aura))}
          >
            {chip.iconUrl === undefined ? (
              // An effect with no art still gets its square: dropping the tile
              // would drop the filter with it, and collapsing it would break
              // the strip's rhythm and move every tile after it.
              <Box className="analysis-aura-tile-blank" />
            ) : (
              <img className="analysis-aura-tile-icon" src={chip.iconUrl} alt="" />
            )}
          </UnstyledButton>
        </AuraTooltip>
      ))}
    </Box>
  );
};
