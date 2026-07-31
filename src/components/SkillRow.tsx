import type { BarFillMode } from "@/stores/useMeterSettingsStore";
import { CharacterType, ComputedSkillState, SkillColumns } from "@/types";
import {
  NO_TARGETS,
  barWidth,
  computeOvercapPercentage,
  damageBarStyle,
  getSkillName,
  mergeTargetBreakdowns,
} from "@/utils";
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
  /** The largest percentage in this breakdown — what `relative` fill scales against. */
  maxPercentage: number;
  fillMode: BarFillMode;
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
  maxPercentage,
  fillMode,
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
      <div role="row" className={`meter-row skill-row ${nested ? "nested" : ""}`}>
        <div role="cell" className={`text-left row-data ${nested ? "nested" : ""}`}>
          {getSkillName(characterType, skill)}
        </div>
        {columns.map((column) => (
          <div key={column} role="cell" className="text-center row-data">
            {column === SkillColumns.Hits ? skill.hits : "-"}
          </div>
        ))}
      </div>
    );
  }

  return (
    <SkillTargetTooltip
      label={getSkillName(characterType, skill)}
      targets={targetBreakdown}
      showFullValues={showFullValues}
      color={color}
    >
      <div
        role="row"
        className={`meter-row skill-row ${nested ? "nested" : ""}`}
        style={damageBarStyle(color, barWidth(skill.percentage, maxPercentage, fillMode))}
      >
        <div role="cell" className={`text-left row-data ${nested ? "nested" : ""}`}>
          {getSkillName(characterType, skill)}
        </div>
        {columns.map(renderCell)}
      </div>
    </SkillTargetTooltip>
  );
};
