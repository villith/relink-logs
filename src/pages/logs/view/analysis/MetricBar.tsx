import { Box } from "@mantine/core";

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
  variant: "row" | "card";
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
 * moment the user was reading it. The outline on the row carries hover instead. */
export const MetricBar = ({ value, subValue, largest, color, variant }: MetricBarProps) => {
  // largest === 0 when every peer is zero (a fight with no stun, say).
  // Guarding here keeps those rows visible at zero width instead of NaN.
  const pct = (amount: number) => (largest === 0 ? 0 : (amount / largest) * 100);
  const supplementary = subValue !== undefined && subValue > 0 ? Math.min(subValue, value) : 0;
  const direct = value - supplementary;

  return (
    <Box
      aria-hidden
      className={[
        // background-color, never the `background` shorthand: the shorthand
        // resets background-size and has broken full-width bars here before.
        // `inset-x-0` is what makes the track's width real — the segments are
        // absolute and contribute nothing, so without it every bar renders at
        // zero pixels.
        //
        // ONE opacity for the row and the card. The card used to override it to
        // 0.38, which was never a reasoned difference, only an unshared literal.
        // Over --color-panel the worst palette entry (#9BCF53) composites to
        // L=0.122, which is 6.1:1 against the card's white label.
        "pointer-events-none absolute inset-x-0 rounded-xs opacity-[0.42]",
        // The row's own separation, so the pixels between two bars still belong
        // to a row and the hover card survives the crossing. The card draws
        // edge to edge; only the row insets.
        variant === "row" ? "inset-y-px" : "inset-y-0",
      ].join(" ")}
    >
      <Box
        data-testid="metric-bar-segment"
        className="pointer-events-none absolute inset-y-0 rounded-xs"
        style={{ left: "0%", width: `${pct(direct)}%`, backgroundColor: color }}
      />
      {supplementary > 0 && (
        <Box
          data-testid="metric-bar-segment"
          className="pointer-events-none absolute inset-y-0 rounded-xs opacity-45"
          style={{ left: `${pct(direct)}%`, width: `${pct(supplementary)}%`, backgroundColor: color }}
        />
      )}
    </Box>
  );
};
