/// The overcap-% table cell shared by SkillRow and SkillGroupRow: a dash when there
/// is no cappable data, otherwise the rounded percentage with a small `%` unit.
export const OvercapCell = ({ percentage }: { percentage: number | null }) => (
  <td className="text-center row-data">
    {percentage === null ? (
      <>-</>
    ) : (
      <span className="capped">
        {percentage.toFixed(0)}
        <span className="font-sm">%</span>
      </span>
    )}
  </td>
);
