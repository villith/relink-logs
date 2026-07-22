import { ComputedSkillGroup, ComputedSkillState, SkillColumns } from "@/types";
import { OvercapCell } from "./OvercapCell";
import { StunCell } from "./StunCell";
import { useSkillRow } from "./useSkillRow";

/** The humanized/derived values a value cell needs, on top of the raw skill data.
 * Mirrors {@link useSkillRow}'s output (skill and group rows both produce it) plus
 * the two row-level extras the switch reads. */
export type SkillCellContext = ReturnType<typeof useSkillRow> & {
  /** Overcap percentage for the Overcap column (null when there's no cappable data). */
  overcapPercentage: number | null;
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds: number;
};

/** Renders one value cell for a skill or skill-group row. Both row components
 * delegate here so every column is defined in exactly one place. */
export const renderSkillCell = (
  column: SkillColumns,
  data: ComputedSkillState | ComputedSkillGroup,
  ctx: SkillCellContext
) => {
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
    overcapPercentage,
    durationSeconds,
  } = ctx;

  switch (column) {
    case SkillColumns.Hits:
      return (
        <td key={column} className="text-center row-data">
          {data.hits}
        </td>
      );
    case SkillColumns.TotalDamage:
      return (
        <td key={column} className="text-center row-data">
          {showFullValues ? (
            data.totalDamage.toLocaleString()
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
            data.minDamage ? (
              data.minDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <>
              {data.minDamage && minDmg}
              <span className="unit font-sm">{minDmgUnit}</span>
            </>
          )}
        </td>
      );
    case SkillColumns.MaxDamage:
      return (
        <td key={column} className="text-center row-data">
          {showFullValues ? (
            data.maxDamage ? (
              data.maxDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <>
              {data.maxDamage && maxDmg}
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
      return <StunCell key={column} value={data.totalStunValue ?? 0} showFullValues={showFullValues} />;
    case SkillColumns.StunEligibleHits:
      return (
        <td key={column} className="text-center row-data">
          {(data.stunEligibleHits ?? 0) > 0 ? data.stunEligibleHits : ""}
        </td>
      );
    case SkillColumns.StunPerEligibleHit: {
      const eligible = data.stunEligibleHits ?? 0;
      const perHit = eligible > 0 ? (data.totalStunValue ?? 0) / eligible : 0;
      return <StunCell key={column} value={perHit} showFullValues={showFullValues} />;
    }
    case SkillColumns.StunPerSecond: {
      const sps = durationSeconds > 0 ? (data.totalStunValue ?? 0) / durationSeconds : 0;
      return (
        <td key={column} className="text-center row-data">
          {sps > 0 ? sps.toFixed(2) : ""}
        </td>
      );
    }
    case SkillColumns.Overcap:
      return <OvercapCell key={column} percentage={overcapPercentage} />;
    case SkillColumns.DamagePercentage:
      return (
        <td key={column} className="text-center row-data">
          {data.percentage.toFixed(0)}
          <span className="unit font-sm">%</span>
        </td>
      );
    default:
      // An id outside the current SkillColumns (e.g. a stale/corrupted persisted
      // list): still emit a cell so the body stays aligned with the header, which
      // renders one <th> per column unconditionally.
      return <td key={column} className="text-center row-data" />;
  }
};
