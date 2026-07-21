import { CharacterType, ComputedSkillGroup } from "@/types";
import { computeOvercapPercentage, getSkillName, mergeTargetBreakdowns } from "@/utils";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useMemo } from "react";
import { OvercapCell } from "./OvercapCell";
import { SkillRow } from "./SkillRow";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { StunCell } from "./StunCell";
import { useSkillGroupRow } from "./useSkillGroupRow";

export type SkillRowProps = {
  characterType: CharacterType;
  group: ComputedSkillGroup;
  color: string;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

export const SkillGroupRow = ({ characterType, group, color, live }: SkillRowProps) => {
  const {
    showFullValues,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    expanded,
    setExpanded,
    sortedSkills,
  } = useSkillGroupRow(group);

  const overcapPercentage = computeOvercapPercentage(group);
  const targetBreakdown = useMemo(
    () => (live ? [] : mergeTargetBreakdowns((group.skills ?? []).map((skill) => skill.targets))),
    [live, group.skills]
  );

  return (
    <>
      <SkillTargetTooltip
        label={getSkillName(group.childCharacterType, group)}
        targets={targetBreakdown}
        showFullValues={showFullValues}
        color={color}
      >
        <tr className="skill-row group" onClick={() => setExpanded(!expanded)}>
          <td className="text-left row-data">
            <span>{getSkillName(group.childCharacterType, group)}</span>
            <span className="p4">{expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}</span>
          </td>
          <td className="text-center row-data">{group.hits}</td>
          <td className="text-center row-data">
            {showFullValues ? (
              group.totalDamage.toLocaleString()
            ) : (
              <>
                {totalDamage}
                <span className="unit font-sm">{totalDamageUnit}</span>
              </>
            )}
          </td>
          <td className="text-center row-data">
            {showFullValues ? (
              group.minDamage ? (
                group.minDamage.toLocaleString()
              ) : (
                ""
              )
            ) : (
              <>
                {group.minDamage && minDmg}
                <span className="unit font-sm">{minDmgUnit}</span>
              </>
            )}
          </td>
          <td className="text-center row-data">
            {showFullValues ? (
              group.maxDamage ? (
                group.maxDamage.toLocaleString()
              ) : (
                ""
              )
            ) : (
              <>
                {group.maxDamage && maxDmg}
                <span className="unit font-sm">{maxDmgUnit}</span>
              </>
            )}
          </td>
          <td className="text-center row-data">
            {showFullValues ? (
              rawAverageDmg.toLocaleString()
            ) : (
              <>
                {averageDmg}
                <span className="unit font-sm">{averageDmgUnit}</span>
              </>
            )}
          </td>
          <StunCell value={group.totalStunValue ?? 0} showFullValues={showFullValues} />
          <OvercapCell percentage={overcapPercentage} />
          <td className="text-center row-data">
            {group.percentage.toFixed(0)}
            <span className="unit font-sm">%</span>
          </td>
          <div className="damage-bar" style={{ backgroundColor: color, width: `${group.percentage}%` }} />
        </tr>
      </SkillTargetTooltip>
      {expanded &&
        sortedSkills.map((skill) => (
          <SkillRow
            key={`${skill.childCharacterType}-${getSkillName(characterType, skill)}`}
            characterType={characterType}
            skill={skill}
            color={color}
            nested
            live={live}
          />
        ))}
    </>
  );
};
