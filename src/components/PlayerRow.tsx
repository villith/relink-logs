import { Fragment, useMemo, type CSSProperties } from "react";

import type { BarFillMode } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, LegalityFinding, PlayerData } from "@/types";
import {
  NO_TARGETS,
  barWidth,
  damageBarStyle,
  mergeTargetBreakdowns,
  playerLabelTokens,
  translatedPlayerName,
} from "@/utils";

import { PlayerLabel } from "./PlayerLabel";
import { SkillBreakdown } from "./SkillBreakdown";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { usePlayerRow } from "./usePlayerRow";

/** Steps a bust is allowed to walk right — one short of a full party, so the
 * last one is still inside the width every row reserves for its icon. */
const MAX_ICON_STEPS = 3;

export const PlayerRow = ({
  live = false,
  player,
  partyData,
  durationSeconds = 0,
  legality,
  maxPercentage,
  fillMode,
  rank = 0,
}: {
  live?: boolean;
  player: ComputedPlayerState;
  partyData: Array<PlayerData | null>;
  durationSeconds?: number;
  /** Where the row sits in the table as drawn, top being 0. Only the icon uses
   * it: each row down steps its bust further right so the ones behind it stay
   * recognisable. It is display position, not party slot — the busts should
   * step down the screen, not follow whatever order the party loaded in. */
  rank?: number;
  /** Build-legality findings per party slot, aligned with `partyData`. */
  legality?: LegalityFinding[][];
  /** The largest percentage among the rows on screen — what `relative` fill scales against. */
  maxPercentage: number;
  fillMode: BarFillMode;
}) => {
  const {
    color,
    legalityColor,
    columns,
    isOpen,
    setIsOpen,
    partySlotIndex,
    showDisplayNames,
    showFullValues,
    playerLabelTemplate,
    matchColumnTypeToValue,
  } = usePlayerRow(live, player, partyData, legality);

  // Two renderings of one label, deliberately. `label` is the text-only form
  // the tooltip takes as a string prop; the row itself renders the same
  // template through PlayerLabel so `{icon}` can draw as an image.
  const label = translatedPlayerName(
    partySlotIndex,
    partyData[partySlotIndex],
    player,
    showDisplayNames,
    playerLabelTemplate
  );

  const labelTokens = playerLabelTokens(partySlotIndex, partyData[partySlotIndex], player, showDisplayNames);

  const targetBreakdown = useMemo(
    () => (live ? NO_TARGETS : mergeTargetBreakdowns(player.skillBreakdown.map((skill) => skill.targets))),
    [live, player.skillBreakdown]
  );

  return (
    <Fragment>
      <SkillTargetTooltip label={label} targets={targetBreakdown} showFullValues={showFullValues} color={color}>
        <div
          role="row"
          className={`meter-row player-row ${isOpen ? "transparent-bg" : ""}`}
          style={
            {
              ...damageBarStyle(color, barWidth(player.percentage, maxPercentage, fillMode)),
              "--player-icon-indent": `calc(${Math.min(rank, MAX_ICON_STEPS)} * var(--player-icon-step))`,
            } as CSSProperties
          }
          onClick={() => setIsOpen(!isOpen)}
        >
          {/* `color` is an inline style rather than a class: the meter's rows
              are plain divs outside Mantine, so the severity name maps to a
              CSS variable the same way Mantine would resolve it. */}
          <div
            role="cell"
            className="text-left row-data player-name"
            style={legalityColor ? { color: `var(--mantine-color-${legalityColor}-5)` } : undefined}
          >
            <PlayerLabel template={playerLabelTemplate} tokens={labelTokens} />
          </div>
          {columns.map((column) => {
            const columnValue = matchColumnTypeToValue(showFullValues, column);

            return (
              <div key={column} role="cell" className="text-center row-data">
                {showFullValues ? (
                  columnValue.value
                ) : (
                  <>
                    {columnValue.value}
                    <span className="unit font-sm">{columnValue.unit}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </SkillTargetTooltip>
      {isOpen && <SkillBreakdown player={player} color={color} durationSeconds={durationSeconds} live={live} />}
    </Fragment>
  );
};
