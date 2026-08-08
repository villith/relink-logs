import { Box, Text } from "@mantine/core";

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
    className={[
      // 30px tall with NO margin, the bar inset 1px top and bottom, rather than
      // 28px with a 2px margin. It draws identically — a 28px bar every 30px —
      // but the separation now belongs to the row instead of sitting between
      // rows. That gap was dead space owned by no hover target: measured at the
      // exact midpoint between two rows, elementFromPoint returned a bare DIV
      // inside neither row, so a cursor crossing it fired mouseleave and tore
      // the hover card down before the next row built it again.
      "relative flex h-row w-full items-center rounded-xs px-2 text-left",
      // Rows touch, so an outline drawn OUTSIDE the box would overlap its
      // neighbour's. Both states draw their ring inside instead, offset by the
      // row's own 1px inset so the ring lands on the bar's edge.
      "hover:outline hover:outline-1 hover:-outline-offset-2 hover:outline-line-strong",
      "focus-visible:-outline-offset-[3px]",
      onClick ? "cursor-pointer" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ")}
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
    <Text
      role="gridcell"
      className={[
        "relative min-w-0 truncate text-lg font-semibold tracking-[-0.01em]",
        // Timeline rows bound the name so the track gets the rest of the row.
        nameFixed ? "flex-none basis-name" : "flex-1",
      ].join(" ")}
    >
      {name}
    </Text>
    {trailing}
    {columns}
  </Box>
);
