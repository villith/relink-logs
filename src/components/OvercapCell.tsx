import { ValueCell } from "./ValueCell";

/// The overcap-% cell shared by SkillRow and SkillGroupRow: a dash when there
/// is no cappable data, otherwise the rounded percentage with a small `%` unit.
export const OvercapCell = ({ percentage }: { percentage: number | null }) => (
  <ValueCell>
    {percentage === null ? (
      <>-</>
    ) : (
      <span className="capped">
        {percentage.toFixed(0)}
        <span className="font-sm">%</span>
      </span>
    )}
  </ValueCell>
);
