import { cn } from "./cn";

export type EntityIconSize = "row" | "bar" | "cardBar" | "control" | "card";

export type EntityIconProps = {
  src: string;
  /** Empty string marks the image decorative — use it when the name is already
   * written beside the art, which is the common case in a table row. */
  alt: string;
  size?: EntityIconSize;
  className?: string;
};

/** The one place a scale is turned into a class. Exported because a caller that
 * draws its own BOX at the art's size — `RowArt`, whose placeholder has to hold
 * the name column's left edge whether or not there is art to put in it — would
 * otherwise restate the same two tokens beside this table and drift from it. */
export const ENTITY_ICON_SIZE_CLASS: Record<EntityIconSize, string> = {
  row: "size-icon",
  bar: "size-art",
  cardBar: "size-art-card",
  control: "size-icon-sm",
  card: "size-icon-xs",
};

/** A row's entity art: a status mark, a character bust, an ability diamond, a
 * boss portrait.
 *
 * A fixed SQUARE with `object-contain`, so the four families' different aspect
 * ratios (the character busts are tall) still line their names up identically.
 *
 * The sizes are the scales the art appears at and nothing else: beside a name,
 * filling a row's BAR or a card row's, a control, a name inside a card. The two
 * bar sizes read the height of the bar they stand at (`--spacing-art`,
 * `--spacing-art-card`), which is what lets a diamond nest exactly into the head
 * `MetricBar` cuts for it. These were four near-identical CSS rules whose only
 * real difference was which size token they read. */
export const EntityIcon = ({ src, alt, size = "row", className }: EntityIconProps) => (
  <img
    src={src}
    alt={alt}
    aria-hidden={alt === "" || undefined}
    className={cn("shrink-0 object-contain", ENTITY_ICON_SIZE_CLASS[size], className)}
  />
);
