export type EntityIconSize = "row" | "control" | "card";

export type EntityIconProps = {
  src: string;
  /** Empty string marks the image decorative — use it when the name is already
   * written beside the art, which is the common case in a table row. */
  alt: string;
  size?: EntityIconSize;
  className?: string;
};

const SIZE_CLASS: Record<EntityIconSize, string> = {
  row: "size-icon",
  control: "size-icon-sm",
  card: "size-icon-xs",
};

/** A row's entity art: a status mark, a character bust, an ability diamond, a
 * boss portrait.
 *
 * A fixed SQUARE with `object-contain`, so the four families' different aspect
 * ratios (the character busts are tall) still line their names up identically.
 *
 * Three sizes, because the art appears at three scales and nothing else: a
 * table row, a control, a hover card. These were four near-identical CSS rules
 * whose only real difference was which size token they read. */
export const EntityIcon = ({ src, alt, size = "row", className }: EntityIconProps) => (
  <img
    src={src}
    alt={alt}
    aria-hidden={alt === "" || undefined}
    className={["shrink-0 object-contain", SIZE_CLASS[size], className].filter(Boolean).join(" ")}
  />
);
