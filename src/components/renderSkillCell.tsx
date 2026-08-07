import { ComputedSkillGroup, ComputedSkillState, SkillColumns } from "@/types";
import { OvercapCell } from "./OvercapCell";
import { StunCell } from "./StunCell";
import { UnitValue, ValueCell } from "./ValueCell";
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
      return <ValueCell key={column}>{data.hits}</ValueCell>;
    case SkillColumns.TotalDamage:
      return (
        <ValueCell key={column}>
          {showFullValues ? (
            data.totalDamage.toLocaleString()
          ) : (
            <UnitValue value={totalDamage} unit={totalDamageUnit} />
          )}
        </ValueCell>
      );
    case SkillColumns.MinDamage:
      return (
        <ValueCell key={column}>
          {showFullValues ? (
            data.minDamage ? (
              data.minDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <UnitValue value={data.minDamage && minDmg} unit={minDmgUnit} />
          )}
        </ValueCell>
      );
    case SkillColumns.MaxDamage:
      return (
        <ValueCell key={column}>
          {showFullValues ? (
            data.maxDamage ? (
              data.maxDamage.toLocaleString()
            ) : (
              ""
            )
          ) : (
            <UnitValue value={data.maxDamage && maxDmg} unit={maxDmgUnit} />
          )}
        </ValueCell>
      );
    case SkillColumns.AverageDamage:
      return (
        <ValueCell key={column}>
          {showFullValues ? rawAverageDmg.toLocaleString() : <UnitValue value={averageDmg} unit={averageDmgUnit} />}
        </ValueCell>
      );
    case SkillColumns.TotalStunValue:
      return <StunCell key={column} value={data.totalStunValue ?? 0} showFullValues={showFullValues} />;
    case SkillColumns.StunEligibleHits:
      return <ValueCell key={column}>{(data.stunEligibleHits ?? 0) > 0 ? data.stunEligibleHits : ""}</ValueCell>;
    case SkillColumns.StunPerEligibleHit: {
      const eligible = data.stunEligibleHits ?? 0;
      const perHit = eligible > 0 ? (data.totalStunValue ?? 0) / eligible : 0;
      return <StunCell key={column} value={perHit} showFullValues={showFullValues} />;
    }
    case SkillColumns.StunPerSecond: {
      const sps = durationSeconds > 0 ? (data.totalStunValue ?? 0) / durationSeconds : 0;
      return <ValueCell key={column}>{sps > 0 ? sps.toFixed(2) : ""}</ValueCell>;
    }
    case SkillColumns.Overcap:
      return <OvercapCell key={column} percentage={overcapPercentage} />;
    case SkillColumns.DamagePercentage:
      return (
        <ValueCell key={column}>
          <UnitValue value={data.percentage.toFixed(0)} unit="%" />
        </ValueCell>
      );
    default:
      // An id outside the current SkillColumns (e.g. a stale/corrupted persisted
      // list): still emit a cell so the body stays aligned with the header, which
      // renders one <th> per column unconditionally.
      return <ValueCell key={column} />;
  }
};
