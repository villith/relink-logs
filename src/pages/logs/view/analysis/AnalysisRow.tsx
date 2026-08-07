import { Box, Text } from "@mantine/core";

import "./analysis.css";

export type AnalysisRowProps = {
  /** The row's name cell, already resolved to a node — this component never
   * looks a label up. Both bodies pass the view's own `renderLabel` output,
   * which is what stops one row being named two different ways. */
  name: React.ReactNode;
  /** Behind the name: the magnitude bar, where the caller draws one. */
  background?: React.ReactNode;
  /** Controls before the name — the band toggle, the expand caret. */
  leading?: React.ReactNode;
  /** Between the name and the columns: the table's uptime track, or the
   * timeline's lane track. */
  trailing?: React.ReactNode;
  /** Numeric cells, after everything else. */
  columns?: React.ReactNode;
  /** What clicking (or Enter/Space on) the row does. Absent, the row is inert:
   * no pointer cursor, no tab stop, no handler at all. */
  onClick?: () => void;
  /** Fixes the name cell's width, for rows whose trailing slot is positional
   * and must therefore start at the same x on every row. */
  nameFixed?: boolean;
  className?: string;
  /** Forwarded to the row's own element. `CursorCard` clones the row to attach
   * these, so a row that dropped them would leave the hover card unopenable. */
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseMove?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
};

/** The one row shell the analysis view draws, in the table and on the timeline.
 *
 * It owns the geometry — height, padding, the name cell and its art — and
 * nothing else. Everything that differs between the two bodies arrives as a
 * slot, which is what lets one component serve both a table row carrying a bar
 * and five figures and a lane carrying a track. */
export const AnalysisRow = ({
  name,
  background,
  leading,
  trailing,
  columns,
  onClick,
  nameFixed,
  className,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
}: AnalysisRowProps) => (
  // A div, not a button. The controls inside it are real <button>s, and a
  // button may not contain interactive content — the row used to be an
  // UnstyledButton with a focusable role="button" span in it, which is invalid
  // and made the two fight over focus and clicks.
  //
  // Focusable and Enter/Space-activated by hand, which is what the <button>
  // was giving for free: a row in a grid is allowed to take focus, and losing
  // keyboard pinning to fix the nesting would be a poor trade.
  <Box
    role="row"
    className={["analysis-row", className, onClick ? "analysis-row-pinnable" : ""].filter(Boolean).join(" ")}
    tabIndex={onClick ? 0 : undefined}
    onClick={onClick}
    onKeyDown={
      onClick &&
      ((event: React.KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick();
      })
    }
    onMouseEnter={onMouseEnter}
    onMouseMove={onMouseMove}
    onMouseLeave={onMouseLeave}
  >
    {background}
    {leading}
    <Text role="gridcell" className={`analysis-name${nameFixed ? " analysis-name-fixed" : ""}`}>
      {name}
    </Text>
    {trailing}
    {columns}
  </Box>
);
