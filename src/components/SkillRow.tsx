import { CharacterType, ComputedSkillState } from "@/types";
import { getSkillName } from "@/utils";
import { isDotAction, isSupplementaryAction } from "./mergeSupplementary";
import { useSkillRow } from "./useSkillRow";

export type SkillRowProps = {
  characterType: CharacterType;
  skill: ComputedSkillState;
  color: string;
  nested?: boolean;
};

export const SkillRow = ({ characterType, skill, color, nested }: SkillRowProps) => {
  const {
    showFullValues,
    mergeSupplementary,
    rawTotalDamage,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    suppDmg,
    suppDmgUnit,
    echoDmg,
    echoDmgUnit,
    ownPercentage,
  } = useSkillRow(skill);

  // Proc columns are meaningless on rows that are themselves procs or DoT.
  const isProcSource = !isSupplementaryAction(skill.actionType) && !isDotAction(skill.actionType);

  return (
    <tr className={`skill-row ${nested ? "nested" : ""}`}>
      {nested ? (
        <td className="text-left row-data nested">{getSkillName(characterType, skill)}</td>
      ) : (
        <td className="text-left row-data">{getSkillName(characterType, skill)}</td>
      )}
      <td className="text-center row-data">{skill.hits}</td>
      <td className="text-center row-data">
        {showFullValues ? (
          rawTotalDamage.toLocaleString()
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
      {mergeSupplementary && (
        <td className="text-center row-data">
          {isProcSource && skill.suppDamage > 0 ? (
            showFullValues ? (
              skill.suppDamage.toLocaleString()
            ) : (
              <>
                {suppDmg}
                <span className="unit font-sm">{suppDmgUnit}</span>
              </>
            )
          ) : (
            ""
          )}
        </td>
      )}
      <td className="text-center row-data">
        {isProcSource ? (
          <>
            {skill.hits > 0 ? ((skill.suppHits / skill.hits) * 100).toFixed(0) : 0}
            <span className="font-sm">%</span>
          </>
        ) : (
          ""
        )}
      </td>
      {mergeSupplementary && (
        <td className="text-center row-data">
          {isProcSource && skill.echoDamage > 0 ? (
            showFullValues ? (
              skill.echoDamage.toLocaleString()
            ) : (
              <>
                {echoDmg}
                <span className="unit font-sm">{echoDmgUnit}</span>
              </>
            )
          ) : (
            ""
          )}
        </td>
      )}
      <td className="text-center row-data">
        {isProcSource ? (
          <>
            {skill.hits > 0 ? ((skill.echoHits / skill.hits) * 100).toFixed(0) : 0}
            <span className="font-sm">%</span>
          </>
        ) : (
          ""
        )}
      </td>
      <td className="text-center row-data">
        {skill.cappedHits > 0 && skill.cappableHits > 0 ? (
          <span className="capped">
            {((skill.cappedHits / skill.cappableHits) * 100).toFixed(0)}
            <span className="font-sm">%</span>
          </span>
        ) : (
          <>
            0<span className="font-sm">%</span>
          </>
        )}
      </td>
      <td className="text-center row-data">
        {skill.percentage.toFixed(0)}
        <span className="unit font-sm">%</span>
      </td>
      <div className="damage-bar" style={{ backgroundColor: color, width: `${ownPercentage}%` }} />
      {(skill.suppPercentage ?? 0) > 0 && (
        <div
          className="damage-bar damage-bar-supp"
          style={{ backgroundColor: color, left: `${ownPercentage}%`, width: `${skill.suppPercentage}%` }}
        />
      )}
      {(skill.echoPercentage ?? 0) > 0 && (
        <div
          className="damage-bar damage-bar-echo"
          style={{
            backgroundColor: color,
            left: `${ownPercentage + (skill.suppPercentage ?? 0)}%`,
            width: `${skill.echoPercentage}%`,
          }}
        />
      )}
    </tr>
  );
};
