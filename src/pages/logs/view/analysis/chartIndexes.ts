import type { Hostility } from "../metrics/types";

/**
 * Which players the per-player chart draws.
 *
 * These are the plot's series when nothing overlays it. The default is the
 * WHOLE party — identity, not the pin's narrowing, decides who is on the plot,
 * so pinning one player cannot drop the curves it is being compared against.
 *
 * The exception is a pinned source with no decomposition to draw in its place
 * (Stun and SBA, and now the aura tabs, whose chart is the metric's own damage
 * plot until an effect is pinned): showing the whole party there answers a
 * question nobody asked of it, and narrowing to the pinned player is the most
 * the data supports.
 *
 * Both guards below are load-bearing rather than defensive. A `source` pin on
 * the ENEMY side is a spawn segment in its own id space, and one that has
 * outlived its party names nobody — filtering player indexes by either leaves
 * an empty plot that cannot say why it is empty.
 */
export const chartPlayerIndexes = ({
  party,
  sourcePin,
  hostility,
  overlaid,
}: {
  /** Every player index the chart could draw, in party order. */
  party: number[];
  sourcePin: number | null;
  /** The EFFECTIVE side — a metric with no enemy side reads friendly. */
  hostility: Hostility;
  /** Whether some other series is drawn INSTEAD of these lines. */
  overlaid: boolean;
}): number[] => {
  if (overlaid || sourcePin === null || hostility === "enemy") return party;
  return party.includes(sourcePin) ? party.filter((index) => index === sourcePin) : party;
};
