import { Box } from "@mantine/core";

/** How a bar's head meets the art standing at it.
 *
 * `notch` — a concave bite, which an ability's DIAMOND fills exactly: the head
 *           is the art box's right half with the bite cut through it, so the
 *           diamond drops in and the two corner slivers frame it.
 * `point` — the same silhouette drawn the other way round, for art that is not
 *           a diamond. The head covers the art's whole box with its left end
 *           cut to the diamond's point, so a character bust stands on the row's
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

/** Half the art, which is what makes a head's slope 45° — the diamond's own. */
const depth = (art: string) => `calc(${art} / 2)`;

/** The proportional track's left edge on a HEADED bar: the art box's RIGHT
 * edge, whichever way the head meets the art. The fill's zero starts where the
 * icon ends and its hundred at the row's right edge — the head is identity,
 * drawn in full whatever the value, and the fill alone states the magnitude.
 * When the head rode the fill inside the measured track, the icon's width was
 * counted into every proportion and a short bar was mostly head.
 *
 * Less one pixel, tucked back UNDER the head: two pieces abutting at a
 * fractional coordinate rasterize separately, and antialiasing opened a
 * hairline of the page between them. The overlap is invisible because head and
 * fill are opaque inside one shared-opacity group (see the render) — the same
 * reason the overlap could not simply be painted before, when each piece
 * carried the opacity itself and any overlap composited darker.
 *
 * Reading `--row-pad` rather than restating `px-2` is what keeps an INDENTED
 * row's geometry under its own art (see `MetricTable`'s subrows).
 *
 * Classes, not inline styles, here and in the head tables below: `calc()` over custom
 * properties is exactly what jsdom's style parser drops, so the geometry would
 * be invisible to a test. */
const TRACK_LEFT: Record<BarVariant, string> = {
  row: "left-[calc(var(--row-pad)_+_var(--spacing-art)_-_1px)] right-0",
  card: "left-[calc(var(--row-pad)_+_var(--spacing-art-card)_-_1px)] right-0",
};

/** The head box's left edge — where the whole silhouette starts, so the hover
 * ring shares it: a notch begins at the art's centre, a point at the art's
 * left edge. */
const HEAD_LEFT: Record<BarVariant, Record<BarHead, string>> = {
  row: {
    notch: "left-[calc(var(--row-pad)_+_var(--spacing-art)/2)]",
    point: "left-[var(--row-pad)]",
  },
  card: {
    notch: "left-[calc(var(--row-pad)_+_var(--spacing-art-card)/2)]",
    point: "left-[var(--row-pad)]",
  },
};

/** How wide the fixed head is. A POINTED head covers the art's whole box, back
 * to its left edge; a NOTCHED head is the box's right half alone — the bite
 * consumes the rest, and the diamond's own left half covers the box's left
 * half in art. */
const HEAD_WIDTH: Record<BarVariant, Record<BarHead, string>> = {
  row: { notch: "w-[calc(var(--spacing-art)/2)]", point: "w-[var(--spacing-art)]" },
  card: { notch: "w-[calc(var(--spacing-art-card)/2)]", point: "w-[var(--spacing-art-card)]" },
};

/** The head's silhouette, in shares of its own box — the box is sized to the
 * art (see `HEAD_WIDTH`), so percentages land the 45° slopes exactly.
 *
 * `point` — the box with its left end cut to the diamond's point.
 * `notch` — the box's left edge notched through to its right edge, leaving the
 *           two corner slivers the nested diamond stands between. */
const HEAD_CLIP: Record<BarHead, string> = {
  point: "polygon(50% 0, 100% 0, 100% 100%, 50% 100%, 0 50%)",
  notch: "polygon(0 0, 100% 0, 100% 100%, 0 100%, 100% 50%)",
};

/** The bar's whole silhouette, as the corners of its clip polygon, clockwise
 * from the one that sits at the head — what the hover ring traces. */
const outline = (head: BarHead, d: string): string[] =>
  head === "notch"
    ? ["0 0", "100% 0", "100% 100%", "0 100%", `${d} 50%`]
    : [`${d} 0`, "100% 0", "100% 100%", `${d} 100%`, "0 50%"];

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
 * 45° diagonal one further pixel along. */
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

/** Every ring a bar can wear, resolved at module load rather than per render
 * of every row. ROW geometry only: the ring renders only under
 * `variant === "row"` (see the render) — a card entry is not a hover target. */
const RING: Record<BarHead, string> = {
  notch: ringClip("notch", ART.row),
  point: ringClip("point", ART.row),
};

/** The proportional fill behind a row, a card entry or a chart tooltip entry.
 *
 * ONE bar wherever a magnitude is drawn, so the three cannot disagree about how
 * long a number looks.
 *
 * A headed bar is TWO pieces: a fixed head in the art's box, drawn in full
 * whatever the value, and the proportional fill starting at the box's right
 * edge. The head is the row's identity — the icon standing on its own colour —
 * and the fill alone states the magnitude, so two rows of one value always
 * draw the same length past their icons.
 *
 * The supplementary split is two SIBLING segments rather than a nested one:
 * the bar already renders under a group opacity, so a child of the same colour
 * inside the direct segment would paint identically to it and no split would
 * appear.
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

  // The row's own separation, so the pixels between two bars still belong to a
  // row and the hover card survives the crossing. The card draws edge to edge;
  // only the row insets.
  const insetY = variant === "row" ? "inset-y-px" : "inset-y-0";

  return (
    <>
      {/* Head and fill inside ONE opacity group. Each piece painting the 0.42
          itself is what drew a seam: two abutting translucent edges antialias
          against the page between them, and overlapping them instead
          composites darker. Opaque pieces under one group opacity can overlap
          freely — which is what lets the fill tuck a pixel back under the head
          (see `TRACK_LEFT`) and the join disappear. */}
      <Box aria-hidden className={["pointer-events-none absolute inset-x-0 opacity-[0.42]", insetY].join(" ")}>
        {/* The fixed head. OUTSIDE the track so the track's width — which the
            segment percentages measure against — is the fill's alone. */}
        {head && (
          <Box
            aria-hidden
            data-bar-head
            className={[
              "pointer-events-none absolute inset-y-0",
              HEAD_LEFT[variant][head],
              HEAD_WIDTH[variant][head],
            ].join(" ")}
            style={{ backgroundColor: color, clipPath: HEAD_CLIP[head] }}
          />
        )}
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
            // The 0.42 lives on the group above — ONE opacity for the row and
            // the card. The card used to override it to 0.38, which was never
            // a reasoned difference, only an unshared literal. Over
            // --color-panel the worst palette entry (#9BCF53) composites to
            // L=0.122, which is 6.1:1 against the card's white label.
            "pointer-events-none absolute inset-y-0 rounded-xs",
            // A headed bar's fill starts where its art box ends and reaches the
            // row's right edge; an unheaded one is full-bleed.
            head ? TRACK_LEFT[variant] : "inset-x-0",
          ].join(" ")}
        >
          <Box
            data-testid="metric-bar-segment"
            // Square left corners against a head: a rounded start cut two dark
            // notches into the very seam the overlap exists to close.
            className={["pointer-events-none absolute inset-y-0", head ? "rounded-r-xs" : "rounded-xs"].join(" ")}
            style={{ left: "0%", width: `${pct(direct)}%`, backgroundColor: color }}
          />
          {supplementary > 0 && (
            <Box
              data-testid="metric-bar-segment"
              className="pointer-events-none absolute inset-y-0 rounded-xs opacity-45"
              style={{
                left: `${pct(direct)}%`,
                width: `${pct(supplementary)}%`,
                backgroundColor: color,
              }}
            />
          )}
        </Box>
      </Box>
      {/* OUTSIDE the track, whose 0.42 opacity would fade it, and only on a row
          — a card entry is not a hover target of its own. The row it sits in
          carries the `group`, and suppresses its own rectangular outline in
          favour of this (see `AnalysisRow`). */}
      {head && variant === "row" && (
        <Box
          aria-hidden
          data-bar-ring
          className={[
            "pointer-events-none absolute opacity-0 group-hover:opacity-100",
            HEAD_LEFT.row[head],
            "right-0",
            insetY,
          ].join(" ")}
          style={{ backgroundColor: "var(--color-line-strong)", clipPath: RING[head] }}
        />
      )}
    </>
  );
};
