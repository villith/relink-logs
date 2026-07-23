import { CharacterType, ComputedSkillGroup, SkillColumns } from "@/types";
import { NO_TARGETS, computeOvercapPercentage, damageBarStyle, getSkillName, mergeTargetBreakdowns } from "@/utils";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useMemo } from "react";
import { SkillRow } from "./SkillRow";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { renderSkillCell } from "./renderSkillCell";
import { useSkillGroupRow } from "./useSkillGroupRow";

export type SkillRowProps = {
  characterType: CharacterType;
  group: ComputedSkillGroup;
  color: string;
  /** The value columns to render, in order (after the Skill name column). */
  columns: SkillColumns[];
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

export const SkillGroupRow = ({ characterType, group, color, columns, durationSeconds = 0, live }: SkillRowProps) => {
  const groupRow = useSkillGroupRow(group);
  const { showFullValues, expanded, setExpanded, sortedSkills } = groupRow;

  const overcapPercentage = computeOvercapPercentage(group);
  const targetBreakdown = useMemo(
    () => (live ? NO_TARGETS : mergeTargetBreakdowns((group.skills ?? []).map((skill) => skill.targets))),
    [live, group.skills]
  );

  // Built once per row, not per column: identical across every cell of the row.
  const cellContext = { ...groupRow, overcapPercentage, durationSeconds };
  const renderCell = (column: SkillColumns) => renderSkillCell(column, group, cellContext);

  return (
    <>
      <SkillTargetTooltip
        label={getSkillName(group.childCharacterType, group)}
        targets={targetBreakdown}
        showFullValues={showFullValues}
        color={color}
      >
        <tr
          className="skill-row group"
          style={damageBarStyle(color, group.percentage)}
          onClick={() => setExpanded(!expanded)}
        >
          <td className="text-left row-data">
            <span>{getSkillName(group.childCharacterType, group)}</span>
            <span className="p4">{expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}</span>
          </td>
          {columns.map(renderCell)}
        </tr>
      </SkillTargetTooltip>
      {expanded &&
        sortedSkills.map((skill) => (
          <SkillRow
            key={`${skill.childCharacterType}-${getSkillName(characterType, skill)}`}
            characterType={characterType}
            skill={skill}
            color={color}
            columns={columns}
            durationSeconds={durationSeconds}
            nested
            live={live}
          />
        ))}
    </>
  );
};
