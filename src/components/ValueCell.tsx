import type { CSSProperties, ReactNode } from "react";

/// One body cell of the meter's tables.
///
/// The overlay's rows are plain divs with ARIA roles rather than a `<table>`,
/// so every cell has to carry `role="cell"` and the `row-data` class that sizes
/// and truncates it (see `.skill-row .row-data` in App.css). That pairing was
/// written out at thirteen call sites across the player, skill, group and
/// value cells — one of them dropping the class would have misaligned a column
/// against a header that renders unconditionally.
///
/// Centred unless told otherwise: only the leading name cell is left-aligned.
export const ValueCell = ({
  align = "center",
  className,
  style,
  children,
}: {
  align?: "center" | "left";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) => (
  <div role="cell" className={`text-${align} row-data${className ? ` ${className}` : ""}`} style={style}>
    {children}
  </div>
);

/// A humanized figure beside its unit — "12.3" and a small "k".
///
/// The unit is a span of its own so it can be styled down; the value is a node
/// rather than a number because some columns render an empty string where they
/// have nothing to show.
export const UnitValue = ({ value, unit }: { value: ReactNode; unit?: ReactNode }) => (
  <>
    {value}
    <span className="unit font-sm">{unit}</span>
  </>
);
