import { humanizeNumbers } from "@/utils";

/// The stun table cell shared by SkillRow and SkillGroupRow: empty when the row
/// carries no stun, otherwise the rounded value (localized in full-value mode,
/// humanized with a unit otherwise).
export const StunCell = ({ value, showFullValues }: { value: number; showFullValues: boolean }) => {
  // Only Perfect Guard rows carry stun; the majority of rows are 0, so skip the
  // rounding/humanizing work and render the same empty cell as before.
  if (value <= 0) {
    return <td className="text-center row-data" />;
  }

  const rounded = Math.round(value);
  const [stun, stunUnit] = humanizeNumbers(rounded);
  return (
    <td className="text-center row-data">
      {showFullValues ? (
        rounded.toLocaleString()
      ) : (
        <>
          {stun}
          <span className="unit font-sm">{stunUnit}</span>
        </>
      )}
    </td>
  );
};
