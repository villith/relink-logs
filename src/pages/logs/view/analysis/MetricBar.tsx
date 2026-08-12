import { Box } from "@mantine/core";

/** How a bar's left end meets the art standing at it.
 *
 * `notch` — a concave bite, which an ability's DIAMOND fills exactly: the bar
 *           starts at the art's centre and the bite's point lands on the art's
 *           right corner.
 * `point` — the same silhouette drawn the other way round, for art that is not
 *           a diamond. The bar starts at the art's left edge and its head IS
 *           the diamond's left half, so a character bust stands on the row's
 *           own colour instead of on the page's ground.
 *
 * Either way the art and the bar together read as ONE shape — a diamond drawn
 * out into a prism, the same figure the timeline draws a cast as. */
export type BarHead = "notch" | "point";

/** Row geometry or card geometry — the axis every table below is keyed by. */
export type BarVariant = "row" | "card";

export type MetricBarProps = {
  value: number;
  /** The supplementary part of `value`, drawn as a fainter segment at the
   * fill's right end. Absent when the row has none or collapse is off — never
   * 0, which would mount an empty segment. */
  subValue?: number;
  /** What a full-width bar represents — the largest peer, never the total.
   * At the abilities level the rows are a subset of one player's damage, so a
   * share-of-total bar would render every row as a sliver. */
  largest: number;
  color: string;
  /** Row geometry differs from card geometry; the fill itself does not. */
  variant: BarVariant;
  /** How the bar meets the art at its left end, where a body draws art at the
   * bar's own height. Absent, the bar is full-bleed and square-ended — the
   * shape for a body that draws no art at all. */
  head?: BarHead;
};

/** The art's height, which is the bar's own — one square, so a 45° head always
 * matches the diamond it is cut for. */
const ART = { row: "var(--spacing-art)", card: "var(--spacing-art-card)" } as const;

/** Half the art, which is what makes a head's slope 45° — the diamond's own,
 * and what makes the bite the diamond's own RIGHT HALF, so the art covers it
 * exactly.
 *
 * Never a share of the fill. Capping it at 35% (so a short bar could not be
 * eaten) is what made short bars bleed into the art: at a stub depth the fill
 * keeps its square left edge and stands as a block inside the art's box, where
 * at full depth every pixel of it is under opaque art. A floor on the fill is
 * the honest fix — see `MIN_FILL`. */
const depth = (art: string) => `calc(${art} / 2)`;

/** How short a headed fill may draw: its head, and a little body behind it.
 *
 * At exactly the head's depth a bar is two corner slivers meeting at a point
 * with nothing joining them — the head with no prism behind it. The floor costs
 * a few pixels of proportion on the smallest rows and is what keeps every bar
 * the same figure. */
const MIN_FILL = (art: string) => `calc(${art} / 2 + 4px)`;

/** The fill's left edge. A notch starts at the art's CENTRE, so its point lands
 * on the art's right corner; a point starts at the art's left edge, so the head
 * fills the art's box behind it. Reading `--row-pad` rather than restating
 * `px-2` is what keeps an INDENTED row's head under its own art (see
 * `MetricTable`'s subrows).
 *
 * Classes, not inline styles: `calc()` over custom properties is exactly what
 * jsdom's style parser drops, so the geometry would be invisible to a test. */
const NOTCH_LEFT: Record<BarVariant, string> = {
  row: "left-[calc(var(--row-pad)_+_var(--spacing-art)/2)] right-0",
  card: "left-[calc(var(--row-pad)_+_var(--spacing-art-card)/2)] right-0",
};

/** A POINTED head starts at the art's left edge whatever the geometry, so it
 * does not vary by variant the way the notch's inset does. */
const POINT_LEFT = "left-[var(--row-pad)] right-0";

const leftOf = (variant: BarVariant, head: BarHead) => (head === "point" ? POINT_LEFT : NOTCH_LEFT[variant]);

/** The bar's silhouette, as the corners of its clip polygon, clockwise from the
 * one that sits at the head.
 *
 * Written ONCE. Both the fill's clip and the hover ring trace this same figure
 * — the ring twice, outer then inset — so stating it per consumer is how the
 * notch's slope comes to differ from the ring drawn around it. */
const outline = (head: BarHead, d: string): string[] =>
  head === "notch"
    ? ["0 0", "100% 0", "100% 100%", "0 100%", `${d} 50%`]
    : [`${d} 0`, "100% 0", "100% 100%", `${d} 100%`, "0 50%"];

/** The head, cut out of the segment that stands at the fill's left edge. */
const clipOf = (head: BarHead, art: string) => `polygon(${outline(head, depth(art)).join(", ")})`;

/** The hover ring, as a ONE-PIECE outline of the bar's own silhouette.
 *
 * A closed outer ring traced clockwise, then the same shape inset by a pixel
 * traced anticlockwise: the opposite winding punches the middle out under the
 * default nonzero fill rule, which leaves a 1px stroke that follows the head's
 * diagonals. An `outline` cannot do this — it frames the border box, which is
 * the rectangle the head exists to break — and a border under a `clip-path` is
 * clipped away along exactly the two edges that matter.
 *
 * The 1.415px and 2.415px are not arbitrary: insetting a 45° corner by a pixel
 * moves it √2 along its bisector, and an inset horizontal edge meets an inset
 * 45° diagonal one further pixel along.
 *
 * The ring spans the whole row, so its head is measured against the art alone —
 * no 35% cap, which only exists to keep a SHORT FILL from being eaten. */
const ringClip = (head: BarHead, art: string) => {
  const d = depth(art);
  const far = "calc(100% - 1px)";
  const outer = outline(head, d);
  // The inset head, insetting the same three corners the outline opens with.
  const start = head === "notch" ? "2.415px 1px" : `calc(${d} + 0.415px) 1px`;
  const tip = head === "notch" ? `calc(${d} + 1.415px) 50%` : "1.415px 50%";
  const back = head === "notch" ? `2.415px ${far}` : `calc(${d} + 0.415px) ${far}`;
  // Closed back to its first corner, then the inset path traced the other way.
  const points = [...outer, outer[0], start, tip, back, `${far} ${far}`, `${far} 1px`, start];
  return `polygon(${points.join(", ")})`;
};

/** Every shape a bar can take, resolved at module load.
 *
 * There are exactly two variants and two heads, so there are four answers — and
 * a bar was rebuilding all of them, seven string allocations for the ring
 * alone, on every render of every row. The same reason `NOTCH_LEFT` above is a
 * table rather than a function. */
const SHAPE: Record<BarVariant, Record<BarHead, { clip: string; ring: string; minWidth: string }>> = {
  row: {
    notch: { clip: clipOf("notch", ART.row), ring: ringClip("notch", ART.row), minWidth: MIN_FILL(ART.row) },
    point: { clip: clipOf("point", ART.row), ring: ringClip("point", ART.row), minWidth: MIN_FILL(ART.row) },
  },
  card: {
    notch: { clip: clipOf("notch", ART.card), ring: ringClip("notch", ART.card), minWidth: MIN_FILL(ART.card) },
    point: { clip: clipOf("point", ART.card), ring: ringClip("point", ART.card), minWidth: MIN_FILL(ART.card) },
  },
};

/** The proportional fill behind a row, a card entry or a chart tooltip entry.
 *
 * ONE bar wherever a magnitude is drawn, so the three cannot disagree about how
 * long a number looks.
 *
 * The supplementary split is two SIBLING segments rather than a nested one:
 * the track already carries an opacity, so a child of the same colour inside
 * it paints identically to its parent and no split would appear.
 *
 * Hover deliberately does NOT raise the fill's opacity. Taking it to 0.62 put
 * three of four row names below 4.5:1 — the row got harder to read at the exact
 * moment the user was reading it. The ring on the bar carries hover instead. */
export const MetricBar = ({ value, subValue, largest, color, variant, head }: MetricBarProps) => {
  // largest === 0 when every peer is zero (a fight with no stun, say).
  // Guarding here keeps those rows visible at zero width instead of NaN.
  const pct = (amount: number) => (largest === 0 ? 0 : (amount / largest) * 100);
  const supplementary = subValue !== undefined && subValue > 0 ? Math.min(subValue, value) : 0;
  const direct = value - supplementary;

  const shape = head ? SHAPE[variant][head] : undefined;
  // The head belongs to whichever segment stands at the fill's left edge, and
  // that is the supplementary one on a row that is supplementary in full.
  // Clipping the TRACK instead would measure the head against the whole row
  // rather than against the fill, and eat a short bar entirely.
  const headOn = (segment: "direct" | "supplementary") =>
    shape && segment === (direct > 0 ? "direct" : "supplementary")
      ? { clipPath: shape.clip, minWidth: shape.minWidth }
      : undefined;

  // The row's own separation, so the pixels between two bars still belong to a
  // row and the hover card survives the crossing. The card draws edge to edge;
  // only the row insets.
  const insetY = variant === "row" ? "inset-y-px" : "inset-y-0";

  return (
    <>
      <Box
        aria-hidden
        // Named, because everything else on a row is aria-hidden too — the art,
        // the ring — and a test picking the track out by that alone finds
        // whichever comes first.
        data-bar-track
        className={[
          // background-color, never the `background` shorthand: the shorthand
          // resets background-size and has broken full-width bars here before.
          // A horizontal inset is what makes the track's width real — the
          // segments are absolute and contribute nothing, so without one every
          // bar renders at zero pixels.
          //
          // ONE opacity for the row and the card. The card used to override it
          // to 0.38, which was never a reasoned difference, only an unshared
          // literal. Over --color-panel the worst palette entry (#9BCF53)
          // composites to L=0.122, which is 6.1:1 against the card's white
          // label.
          "pointer-events-none absolute rounded-xs opacity-[0.42]",
          // A headed bar starts at its art and still reaches the row's right
          // edge; an unheaded one is full-bleed.
          head ? leftOf(variant, head) : "inset-x-0",
          insetY,
        ].join(" ")}
      >
        <Box
          data-testid="metric-bar-segment"
          className="pointer-events-none absolute inset-y-0 rounded-xs"
          style={{ left: "0%", width: `${pct(direct)}%`, backgroundColor: color, ...headOn("direct") }}
        />
        {supplementary > 0 && (
          <Box
            data-testid="metric-bar-segment"
            className="pointer-events-none absolute inset-y-0 rounded-xs opacity-45"
            style={{
              left: `${pct(direct)}%`,
              width: `${pct(supplementary)}%`,
              backgroundColor: color,
              ...headOn("supplementary"),
            }}
          />
        )}
      </Box>
      {/* OUTSIDE the track, whose 0.42 opacity would fade it, and only on a row
          — a card entry is not a hover target of its own. The row it sits in
          carries the `group`, and suppresses its own rectangular outline in
          favour of this (see `AnalysisRow`). */}
      {head && shape && variant === "row" && (
        <Box
          aria-hidden
          data-bar-ring
          className={[
            "pointer-events-none absolute opacity-0 group-hover:opacity-100",
            leftOf(variant, head),
            insetY,
          ].join(" ")}
          style={{ backgroundColor: "var(--color-line-strong)", clipPath: shape.ring }}
        />
      )}
    </>
  );
};
