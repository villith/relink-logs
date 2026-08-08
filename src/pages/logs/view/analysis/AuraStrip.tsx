import { Box, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { Label } from "@/components/ui/Label";
import { Strip } from "@/components/ui/Strip";

import { HOVER_PANEL_CLASS } from "./HoverCard";

import "./analysis.css";

/** A tile: art alone, in a square the size of a chip's height. The border does
 * the whole job the removed text and ✕ used to share — it marks which effect
 * the view is filtered by. */
const TILE_CLASS =
  "inline-flex size-[calc(26px*var(--density))] cursor-pointer items-center justify-center rounded-sm border border-line-strong bg-panel p-px";

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
  /** Toggles one effect in the shared filter. There is deliberately no strip
   * ✕: each tile is its own clear, and the two strips select into ONE list, so
   * a "clear all" on either would be a control on one strip that empties the
   * other — which is the surprise this rework exists to remove. */
  onToggle: (aura: string) => void;
  /** True once MORE THAN ONE effect is selected across both strips, which is
   * when the title has to say the selections intersect. */
  stacked: boolean;
  /** How much of the window the whole stack admits, or null when there is no
   * stack — see `ChartWindowModel.auraStackPercent`. */
  stackPercent: number | null;
};

/** One chip's hover card: what the tile itself no longer says.
 *
 * The same panel as the metric hover card (`HOVER_PANEL_CLASS`, and
 * `CursorCard` under it), because a reader should not have to learn two kinds
 * of tooltip in one view. Sized to its content rather than to that card's
 * 300px floor — an effect name and a percentage do not need the width, and a
 * panel three times wider than its text reads as a mis-render.
 *
 * A SELECTED tile inside a stack also states what the stack admits, because its
 * own uptime is no longer what the view is showing — the intersection is, and
 * that figure appears nowhere else. */
const AuraTooltip = ({
  label,
  uptimePercent,
  selected,
  stackPercent,
  children,
}: AuraChip & { stackPercent: number | null; children: React.ReactElement }) => {
  const { t } = useTranslation();

  return (
    <CursorCard
      testId="aura-hover-card"
      className={HOVER_PANEL_CLASS}
      style={{ maxWidth: 280 }}
      content={
        <Box className="px-[9px] py-1.5">
          <Text className="text-md text-white">{label}</Text>
          <Label>{t("ui.logs.aura-uptime", { percent: uptimePercent })}</Label>
          {selected && stackPercent !== null && (
            <Label data-aura-stack>{t("ui.logs.aura-stack-uptime", { percent: stackPercent })}</Label>
          )}
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
 * SEVERAL tiles select at once, and they compose by INTERSECTION: the view
 * narrows to the time every selected effect was up together. The source and
 * target strips select into ONE list and apply together — they used to replace
 * each other, so picking a target effect silently dropped the source one the
 * strip above was still drawing as selected. While more than one is picked the
 * title says "(all)", because a row of ticked tiles otherwise reads as "any of
 * these".
 *
 * The tile is also its own clear: clicking a selected one deselects it. It
 * carries no ✕ — beside a 24px square that control would make the selected
 * tile visibly wider than its neighbours and shuffle the whole strip on every
 * click — but the §1.2 rule it served still holds, since the live filter stays
 * visible as the selected tiles and dismissible by clicking them.
 *
 * Renders nothing with no chips: a strip exists only while what anchors it
 * does, and an empty row of chrome would say nothing. */
export const AuraStrip = ({ titleKey, chips, onToggle, stacked, stackPercent }: AuraStripProps) => {
  const { t } = useTranslation();

  if (chips.length === 0) return null;

  return (
    <Strip rule="top" wrap>
      <Label>{stacked ? t("ui.logs.aura-title-all", { title: t(titleKey) }) : t(titleKey)}</Label>
      {chips.map((chip) => (
        <AuraTooltip key={chip.aura} {...chip} stackPercent={stackPercent}>
          <UnstyledButton
            className={[
              TILE_CLASS,
              // Hover has to read on a tile with no text to brighten, so the
              // border lifts toward the accent before the click that would
              // commit it — and a selected tile is past that, so it keeps its
              // ring rather than dropping back to the hover colour.
              chip.selected
                ? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--color-accent)]"
                : "hover:border-ink-3",
            ].join(" ")}
            aria-pressed={chip.selected}
            // The tile writes nothing, so this is the only name it has.
            aria-label={chip.label}
            // Toggles ITSELF rather than clearing the whole filter: with several
            // selected, deselecting one must leave the rest standing.
            onClick={() => onToggle(chip.aura)}
          >
            {chip.iconUrl === undefined ? (
              // An effect with no art still gets its square: dropping the tile
              // would drop the filter with it, and collapsing it would break
              // the strip's rhythm and move every tile after it. Deliberately
              // not a glyph or a "?" — it stands for "this effect has no
              // picture", not for "unknown effect".
              <Box data-tile-blank className="size-full rounded-xs bg-ink-3 opacity-[0.28]" />
            ) : (
              // Unselected art sits back a little so the selected tile reads first.
              <img
                className={["size-full object-contain", chip.selected ? "opacity-100" : "opacity-85"].join(" ")}
                src={chip.iconUrl}
                alt=""
              />
            )}
          </UnstyledButton>
        </AuraTooltip>
      ))}
    </Strip>
  );
};
