import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { Fragment, useMemo } from "react";

import { ComputedPlayerState, PlayerData } from "@/types";
import { NO_TARGETS, mergeTargetBreakdowns, translatedPlayerName } from "@/utils";

import { SkillBreakdown } from "./SkillBreakdown";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { usePlayerRow } from "./usePlayerRow";

export const PlayerRow = ({
  live = false,
  player,
  partyData,
  durationSeconds = 0,
}: {
  live?: boolean;
  player: ComputedPlayerState;
  partyData: Array<PlayerData | null>;
  durationSeconds?: number;
}) => {
  const {
    color,
    columns,
    isOpen,
    setIsOpen,
    partySlotIndex,
    showDisplayNames,
    showFullValues,
    matchColumnTypeToValue,
  } = usePlayerRow(live, player, partyData);

  const targetBreakdown = useMemo(
    () => (live ? NO_TARGETS : mergeTargetBreakdowns(player.skillBreakdown.map((skill) => skill.targets))),
    [live, player.skillBreakdown]
  );

  return (
    <Fragment>
      <SkillTargetTooltip
        label={translatedPlayerName(partySlotIndex, partyData[partySlotIndex], player, showDisplayNames)}
        targets={targetBreakdown}
        showFullValues={showFullValues}
        color={color}
      >
        <tr className={`player-row ${isOpen ? "transparent-bg" : ""}`} onClick={() => setIsOpen(!isOpen)}>
          <td className="text-left row-data">
            {translatedPlayerName(partySlotIndex, partyData[partySlotIndex], player, showDisplayNames)}
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
          <div className="damage-bar" style={{ backgroundColor: color, width: `${player.percentage}%` }} />
        </tr>
      </SkillTargetTooltip>
      {isOpen && <SkillBreakdown player={player} color={color} durationSeconds={durationSeconds} live={live} />}
    </Fragment>
  );
};
