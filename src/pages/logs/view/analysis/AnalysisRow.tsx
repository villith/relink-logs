import { Box, Text } from "@mantine/core";

import { cn } from "@/components/ui/cn";

export type AnalysisRowProps = {
  /** The row's name cell, already resolved to a node — this component never
   * looks a label up. Both bodies pass the view's own `renderLabel` output,
   * which is what stops one row being named two different ways. */
  name: React.ReactNode;
  /** Behind the name: the magnitude bar, where the caller draws one. */
  background?: React.ReactNode;
  /** The row's entity art, at the head of the row and before its controls.
   * Its own slot rather than a piece of `name`, because a row that draws art at
   * BAR height cannot carry it inside a one-line truncating text cell — and
   * because the bar's notch is anchored to where this box starts. */
  art?: React.ReactNode;
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
  /** Whether the shell draws the hover ring itself, as a rectangle around the
   * whole row. Off for a row whose BAR draws one in its own silhouette — a
   * headed bar is not a rectangle, and framing it with one states a shape the
   * row does not have. The row still carries `group`, which is what lets the
   * bar's ring see the hover. Focus is untouched either way: a focus ring is an
   * accessibility affordance, and the rectangle is the honest bound of what
   * takes the key. */
  hoverOutline?: boolean;
  className?: string;
  /** Forwarded to the row's own element. `CursorCard` clones the row to attach
   * these, so a row that dropped them would leave the hover card unopenable. */
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseMove?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  /** Forwarded to the row's own element. The events stream virtualises its
   * rows, so it positions each one absolutely — geometry only the caller can
   * know, on the element that owns the row's box. */
  style?: React.CSSProperties;
  /** The row's own hover text, for a row that has something to explain about
   * itself as a whole — the events stream's re-admitted context rows. */
  title?: string;
  /** Any `data-*` the caller marks its rows with — `data-subrow` for a child
   * behind an expanded parent, `data-event-row` for a row of the stream.
   * Attributes rather than styling classes, so a test can tell one row from
   * another without reading how either is painted. */
  [dataAttribute: `data-${string}`]: unknown;
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
  art,
  leading,
  trailing,
  columns,
  onClick,
  nameFixed,
  hoverOutline = true,
  className,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
  ...rest
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
    {...rest}
    role="row"
    className={cn(
      // 30px tall with NO margin, the bar inset 1px top and bottom, rather than
      // 28px with a 2px margin. It draws identically — a 28px bar every 30px —
      // but the separation now belongs to the row instead of sitting between
      // rows. That gap was dead space owned by no hover target: measured at the
      // exact midpoint between two rows, elementFromPoint returned a bare DIV
      // inside neither row, so a cursor crossing it fired mouseleave and tore
      // the hover card down before the next row built it again.
      // The left padding is a variable, not `px-2`: an indented row overrides
      // `--row-pad` alone and the bar's notch — anchored to the same token —
      // moves with the art instead of being left behind at the row's edge.
      // `group` so a bar inside can draw the hover ring in its own shape.
      "group relative flex h-row w-full items-center rounded-xs pl-[var(--row-pad)] pr-2 text-left",
      // Rows touch, so an outline drawn OUTSIDE the box would overlap its
      // neighbour's. Both states draw their ring inside instead, offset by the
      // row's own 1px inset so the ring lands on the bar's edge.
      hoverOutline && "hover:outline hover:outline-1 hover:-outline-offset-2 hover:outline-line-strong",
      "focus-visible:-outline-offset-[3px]",
      onClick && "cursor-pointer",
      className
    )}
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
    {art}
    {leading}
    <Text
      role="gridcell"
      className={cn(
        "relative min-w-0 truncate text-lg font-semibold tracking-[-0.01em]",
        // Timeline rows bound the name so the track gets the rest of the row.
        nameFixed ? "flex-none basis-name" : "flex-1"
      )}
    >
      {name}
    </Text>
    {trailing}
    {columns}
  </Box>
);
