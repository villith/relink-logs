import { CharacterType, ComputedSkillState, SkillColumns } from "@/types";
import { NO_TARGETS, computeOvercapPercentage, damageBarStyle, getSkillName, mergeTargetBreakdowns } from "@/utils";
import { useMemo } from "react";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { renderSkillCell } from "./renderSkillCell";
import { useSkillRow } from "./useSkillRow";

export type SkillRowProps = {
  characterType: CharacterType;
  skill: ComputedSkillState;
  color: string;
  /** The value columns to render, in order (after the Skill name column). */
  columns: SkillColumns[];
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
  nested?: boolean;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

export const SkillRow = ({
  characterType,
  skill,
  color,
  columns,
  durationSeconds = 0,
  nested,
  live,
}: SkillRowProps) => {
  const skillRow = useSkillRow(skill);
  const { showFullValues } = skillRow;

  const overcapPercentage = computeOvercapPercentage(skill);
  const targetBreakdown = useMemo(
    () => (live ? NO_TARGETS : mergeTargetBreakdowns([skill.targets])),
    [live, skill.targets]
  );

  // Built once per row, not per column: identical across every cell of the row.
  const cellContext = { ...skillRow, overcapPercentage, durationSeconds };
  const renderCell = (column: SkillColumns) => renderSkillCell(column, skill, cellContext);

  // A guarded Quickening (The World) tracks only that the guard happened — no
  // damage or stun exists to show, so every column except the hit count renders
  // a dash (which keeps the row aligned with whatever columns are visible).
  if (skill.actionType === "PerfectGuardQuickening") {
    return (
      <tr className={`skill-row ${nested ? "nested" : ""}`}>
        <td className={`text-left row-data ${nested ? "nested" : ""}`}>{getSkillName(characterType, skill)}</td>
        {columns.map((column) => (
          <td key={column} className="text-center row-data">
            {column === SkillColumns.Hits ? skill.hits : "-"}
          </td>
        ))}
      </tr>
    );
  }

  return (
    <SkillTargetTooltip
      label={getSkillName(characterType, skill)}
      targets={targetBreakdown}
      showFullValues={showFullValues}
      color={color}
    >
      <tr className={`skill-row ${nested ? "nested" : ""}`} style={damageBarStyle(color, skill.percentage)}>
        <td className={`text-left row-data ${nested ? "nested" : ""}`}>{getSkillName(characterType, skill)}</td>
        {columns.map(renderCell)}
      </tr>
    </SkillTargetTooltip>
  );
};
