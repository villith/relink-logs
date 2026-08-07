import { Box } from "@mantine/core";

import "./analysis.css";

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
 * `.analysis-bar` already carries an opacity, so a child of the same colour
 * inside it paints identically to its parent and no split would appear. */
export const MetricBar = ({ value, subValue, largest, color, variant }: MetricBarProps) => {
  // largest === 0 when every peer is zero (a fight with no stun, say).
  // Guarding here keeps those rows visible at zero width instead of NaN.
  const pct = (amount: number) => (largest === 0 ? 0 : (amount / largest) * 100);
  const supplementary = subValue !== undefined && subValue > 0 ? Math.min(subValue, value) : 0;
  const direct = value - supplementary;

  return (
    <Box className={`analysis-bar analysis-bar-${variant}`} aria-hidden>
      <Box
        data-testid="metric-bar-segment"
        className="analysis-bar-fill"
        style={{ left: "0%", width: `${pct(direct)}%`, backgroundColor: color }}
      />
      {supplementary > 0 && (
        <Box
          data-testid="metric-bar-segment"
          className="analysis-bar-fill analysis-bar-supplementary"
          style={{ left: `${pct(direct)}%`, width: `${pct(supplementary)}%`, backgroundColor: color }}
        />
      )}
    </Box>
  );
};
