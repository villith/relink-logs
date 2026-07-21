import { CharacterType, ComputedSkillState } from "@/types";
import { computeOvercapPercentage, getSkillName, mergeTargetBreakdowns } from "@/utils";
import { useMemo } from "react";
import { OvercapCell } from "./OvercapCell";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { useSkillRow } from "./useSkillRow";

export type SkillRowProps = {
  characterType: CharacterType;
  skill: ComputedSkillState;
  color: string;
  nested?: boolean;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

export const SkillRow = ({ characterType, skill, color, nested, live }: SkillRowProps) => {
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
  } = useSkillRow(skill);

  const overcapPercentage = computeOvercapPercentage(skill);
  const targetBreakdown = useMemo(() => (live ? [] : mergeTargetBreakdowns([skill.targets])), [live, skill.targets]);

  return (
    <SkillTargetTooltip
      label={getSkillName(characterType, skill)}
      targets={targetBreakdown}
      showFullValues={showFullValues}
      color={color}
    >
      <tr className={`skill-row ${nested ? "nested" : ""}`}>
        {nested ? (
          <td className="text-left row-data nested">{getSkillName(characterType, skill)}</td>
        ) : (
          <td className="text-left row-data">{getSkillName(characterType, skill)}</td>
        )}
        <td className="text-center row-data">{skill.hits}</td>
        <td className="text-center row-data">
          {showFullValues ? (
            skill.totalDamage.toLocaleString()
          ) : (
            <>
              {totalDamage}
              <span className="unit font-sm">{totalDamageUnit}</span>
            </>
          )}
        </td>
        <td className="text-center row-data">
          {showFullValues ? (
            skill.minDamage ? (
              skill.minDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <>
              {skill.minDamage && minDmg}
              <span className="unit font-sm">{minDmgUnit}</span>
            </>
          )}
        </td>
        <td className="text-center row-data">
          {showFullValues ? (
            skill.maxDamage ? (
              skill.maxDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <>
              {skill.maxDamage && maxDmg}
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
        <OvercapCell percentage={overcapPercentage} />
        <td className="text-center row-data">
          {skill.percentage.toFixed(0)}
          <span className="unit font-sm">%</span>
        </td>
        <div className="damage-bar" style={{ backgroundColor: color, width: `${skill.percentage}%` }} />
      </tr>
    </SkillTargetTooltip>
  );
};
