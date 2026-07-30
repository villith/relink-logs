import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { Fragment, useMemo } from "react";

import type { BarFillMode } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, LegalityFinding, PlayerData } from "@/types";
import { NO_TARGETS, barWidth, damageBarStyle, mergeTargetBreakdowns, translatedPlayerName } from "@/utils";

import { SkillBreakdown } from "./SkillBreakdown";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { usePlayerRow } from "./usePlayerRow";

export const PlayerRow = ({
  live = false,
  player,
  partyData,
  durationSeconds = 0,
  legality,
  maxPercentage,
  fillMode,
}: {
  live?: boolean;
  player: ComputedPlayerState;
  partyData: Array<PlayerData | null>;
  durationSeconds?: number;
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

  const label = translatedPlayerName(
    partySlotIndex,
    partyData[partySlotIndex],
    player,
    showDisplayNames,
    playerLabelTemplate
  );

  const targetBreakdown = useMemo(
    () => (live ? NO_TARGETS : mergeTargetBreakdowns(player.skillBreakdown.map((skill) => skill.targets))),
    [live, player.skillBreakdown]
  );

  return (
    <Fragment>
      <SkillTargetTooltip label={label} targets={targetBreakdown} showFullValues={showFullValues} color={color}>
        <tr
          className={`player-row ${isOpen ? "transparent-bg" : ""}`}
          style={damageBarStyle(color, barWidth(player.percentage, maxPercentage, fillMode))}
          onClick={() => setIsOpen(!isOpen)}
        >
          {/* `color` is an inline style rather than a class: the meter's rows
              are plain <td>s outside Mantine, so the severity name maps to a
              CSS variable the same way Mantine would resolve it. */}
          <td
            className="text-left row-data"
            style={legalityColor ? { color: `var(--mantine-color-${legalityColor}-5)` } : undefined}
          >
            {label}
          </td>
          {columns.map((column) => {
            const columnValue = matchColumnTypeToValue(showFullValues, column);

            return (
              <td key={column} className="text-center row-data">
                {showFullValues ? (
                  columnValue.value
                ) : (
                  <>
                    {columnValue.value}
                    <span className="unit font-sm">{columnValue.unit}</span>
                  </>
                )}
              </td>
            );
          })}
          <td className="text-center row-button">{isOpen ? <CaretUp size={16} /> : <CaretDown size={16} />}</td>
        </tr>
      </SkillTargetTooltip>
      {isOpen && <SkillBreakdown player={player} color={color} durationSeconds={durationSeconds} live={live} />}
    </Fragment>
  );
};
