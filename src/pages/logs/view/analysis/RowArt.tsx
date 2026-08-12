import { cn } from "@/components/ui/cn";
import { ENTITY_ICON_SIZE_CLASS, EntityIcon } from "@/components/ui/EntityIcon";

/** The shape the game draws its ability art as, and so the shape a bar's head
 * is cut to. Every piece of art on a row is presented as one of these, whatever
 * its own outline. */
const DIAMOND_CLIP = "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)";

/** What a diamond is filled with when the art does not fill it itself.
 *
 * EVERY piece of art gets it. An ability's diamond covers it exactly, so it is
 * only ever seen behind art that is a cut-out — a character bust, an enemy
 * portrait, a status mark — which is precisely the art that has no ground of
 * its own and floated on whatever colour the row happened to be. Faint enough
 * that the bar's colour still reads through, since that colour is what says
 * whose row it is. Behind an art-LESS row the diamond is the whole mark, which
 * is why the two are one shape drawn twice rather than two shapes. */
const DIAMOND_GROUND = "rgba(0, 0, 0, 0.35)";
const DIAMOND_EMPTY = "rgba(255, 255, 255, 0.06)";

/** Which art a row wears, and so which way its bar meets it — see `BarHead`.
 * An ability's DIAMOND nests into a bite cut for it; an actor's bust or
 * portrait has no diamond to nest, so the bar's own head is drawn behind it. */
export type RowArtShape = "diamond" | "actor";

export type RowArtProps = {
  /** The row's art, or nothing where the row names a thing the game draws no
   * picture for — a link attack, an echo, a DoT, an unnamed status. */
  src?: string;
  shape?: RowArtShape;
  /** Which bar the art stands at, and so which height it takes. */
  scale?: "row" | "card";
};

/** Which of `EntityIcon`'s scales a row's art and a card entry's art take. The
 * box and the image inside it read the SAME entry, so the placeholder a row
 * without art draws can never be a different size from the art it stands in
 * for. */
const ICON_SIZE = { row: "bar", card: "cardBar" } as const;

/** Art standing on a coloured bar carries its own separation: the row's own
 * colour is behind it, and a bust with no edge dissolves into it. Shared with
 * the timeline, which stands the same art on the same bar. */
export const ART_SHADOW = "drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]";

/** A row's art, as tall as the bar behind it and standing at the row's head.
 *
 * The bar's left end is cut to meet it: a diamond drops into a 45° bite whose
 * point lands on the art's right corner, while a bust stands on a head the bar
 * draws for it — the diamond's left half, in the row's own colour (see
 * `MetricBar`). Either way the art and its bar read as ONE shape, the same
 * prism the timeline draws a cast as.
 *
 * Every piece of art stands on a diamond ground: only the ability art IS a
 * diamond, and a bust, a boss portrait or a status mark is a cut-out that
 * otherwise floats on whatever colour the row happens to be. The art itself is
 * NOT clipped to that diamond — a bust is wider at the shoulders than a diamond
 * is at its base, and clipping it cuts them off.
 *
 * A row with no art still draws the box: it holds the name column's left edge
 * steady down the whole table. Where a diamond would have nested it draws a
 * faint one, so the bite is filled rather than left as a shape cut for nothing;
 * on an actor's row there is no bite, so the box stays empty and the bar's own
 * head shows through it. */
export const RowArt = ({ src, shape = "diamond", scale = "row" }: RowArtProps) => {
  // `relative`, like every other cell on the row: the bar is absolute, so
  // in-flow content without it is painted over.
  const box = cn("relative mr-[7px] shrink-0", ENTITY_ICON_SIZE_CLASS[ICON_SIZE[scale]]);

  if (src === undefined) {
    return (
      // A plain div: the placeholder needs no theme, and a Mantine Box would
      // make every row that lacks art depend on a provider being mounted.
      <div
        aria-hidden
        data-row-art-empty
        className={box}
        style={shape === "diamond" ? { clipPath: DIAMOND_CLIP, backgroundColor: DIAMOND_EMPTY } : undefined}
      />
    );
  }

  return (
    <div className={box}>
      {/* Under EVERY piece of art, not only the art that needs it. An ability's
          diamond fills this shape exactly and hides it; everything else — a
          character bust, an enemy portrait, a status mark — is a cut-out that
          does not, and gets the ground it has no way to ask for. Drawing it
          always is what stops a new kind of art arriving without one. */}
      <div
        aria-hidden
        data-row-art-ground
        className="absolute inset-0"
        style={{ clipPath: DIAMOND_CLIP, backgroundColor: DIAMOND_GROUND }}
      />
      <EntityIcon
        size={ICON_SIZE[scale]}
        src={src}
        alt=""
        // Contained, never cropped to the diamond: a bust is wider at the
        // shoulders than a diamond is at its base, so clipping cuts them off.
        className={cn("absolute inset-0", ART_SHADOW)}
      />
    </div>
  );
};
