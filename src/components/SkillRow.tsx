import { CharacterType, ComputedSkillState, SkillColumns } from "@/types";
import { computeOvercapPercentage, getSkillName, mergeTargetBreakdowns } from "@/utils";
import { useMemo } from "react";
import { OvercapCell } from "./OvercapCell";
import { SkillTargetTooltip } from "./SkillTargetTooltip";
import { StunCell } from "./StunCell";
import { useSkillRow } from "./useSkillRow";

export type SkillRowProps = {
  characterType: CharacterType;
  skill: ComputedSkillState;
  color: string;
  /** The value columns to render, in order (after the Skill name column). */
  columns: SkillColumns[];
  nested?: boolean;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

export const SkillRow = ({ characterType, skill, color, columns, nested, live }: SkillRowProps) => {
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

  const renderCell = (column: SkillColumns) => {
    switch (column) {
      case SkillColumns.Hits:
        return (
          <td key={column} className="text-center row-data">
            {skill.hits}
          </td>
        );
      case SkillColumns.TotalDamage:
        return (
          <td key={column} className="text-center row-data">
            {showFullValues ? (
              skill.totalDamage.toLocaleString()
            ) : (
              <>
                {totalDamage}
                <span className="unit font-sm">{totalDamageUnit}</span>
              </>
            )}
          </td>
        );
      case SkillColumns.MinDamage:
        return (
          <td key={column} className="text-center row-data">
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
        );
      case SkillColumns.MaxDamage:
        return (
          <td key={column} className="text-center row-data">
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
        );
      case SkillColumns.AverageDamage:
        return (
          <td key={column} className="text-center row-data">
            {showFullValues ? (
              rawAverageDmg.toLocaleString()
            ) : (
              <>
                {averageDmg}
                <span className="unit font-sm">{averageDmgUnit}</span>
              </>
            )}
          </td>
        );
      case SkillColumns.TotalStunValue:
        return <StunCell key={column} value={skill.totalStunValue ?? 0} showFullValues={showFullValues} />;
      case SkillColumns.StunEligibleHits:
        return (
          <td key={column} className="text-center row-data">
            {(skill.stunEligibleHits ?? 0) > 0 ? skill.stunEligibleHits : ""}
          </td>
        );
      case SkillColumns.StunPerEligibleHit: {
        const eligible = skill.stunEligibleHits ?? 0;
        const perHit = eligible > 0 ? (skill.totalStunValue ?? 0) / eligible : 0;
        return <StunCell key={column} value={perHit} showFullValues={showFullValues} />;
      }
      case SkillColumns.Overcap:
        return <OvercapCell key={column} percentage={overcapPercentage} />;
      case SkillColumns.DamagePercentage:
        return (
          <td key={column} className="text-center row-data">
            {skill.percentage.toFixed(0)}
            <span className="unit font-sm">%</span>
          </td>
        );
    }
  };

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
      <tr className={`skill-row ${nested ? "nested" : ""}`}>
        <td className={`text-left row-data ${nested ? "nested" : ""}`}>{getSkillName(characterType, skill)}</td>
        {columns.map(renderCell)}
        <div className="damage-bar" style={{ backgroundColor: color, width: `${skill.percentage}%` }} />
      </tr>
    </SkillTargetTooltip>
  );
};
