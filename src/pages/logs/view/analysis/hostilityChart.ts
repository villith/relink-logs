import type { EnemySeries, EnemyType } from "@/types";

import type { DrillSeries } from "./drillSeries";

/** The enemy side's stacked bands: one per enemy TYPE, ready to plot.
 *
 * The same `{key, label, values}` shape as a drill band or a status stack
 * series, so the view feeds all three through one overlay path rather than
 * three near-identical ones.
 *
 * WHICH SERIES BELONGS TO WHICH TAB is the whole point of this function, and it
 * is the one mapping in this feature that has been inverted before:
 *
 * - Damage Done → Enemies ranks enemies by what they DEALT to the party, so it
 *   draws the dealt series.
 * - Damage Taken → Enemies ranks enemies by what they RECEIVED from the party,
 *   so it draws the received series.
 *
 * Both read backwards at a glance, which is exactly why they get inverted: the
 * enemy side of a tab is the OTHER END of the same hits. Damage Done's friendly
 * figures are the party's output, so its enemy side is the party's input; the
 * name of the tab describes the friendly column, never the enemy one.
 *
 * The two sources arrive in an object rather than as positional arguments for
 * the same reason: two parameters of one type, in a function whose only job is
 * telling them apart, is precisely the shape a swap hides.
 *
 * Order is the backend's (largest first) and is deliberately not re-sorted here
 * — the table ranks them the same way, and two sort rules would let the biggest
 * band and the top row disagree.
 *
 * Null — never an empty array — for a tab with no enemy-side damage series at
 * all (the status tabs) and for a log that carries none (nothing recorded
 * incoming damage before damage-taken capture existed). The caller then keeps
 * whatever chart it was already drawing instead of blanking the plot. */
export const hostilitySeriesFor = ({
  metricKey,
  dealt,
  received,
  enemyName,
}: {
  /** The selected metric tab's key. */
  metricKey: string;
  /** What each enemy type DEALT to the party, per chart bucket. */
  dealt: EnemySeries[];
  /** What each enemy type RECEIVED from the party, per chart bucket. */
  received: EnemySeries[];
  /** Injected so this stays pure and testable; the view passes
   * `translateEnemyType`. */
  enemyName: (enemyType: EnemyType) => string;
}): DrillSeries[] | null => {
  const source = metricKey === "damage" ? dealt : metricKey === "taken" ? received : null;
  if (source === null || source.length === 0) return null;

  return source.map((series) => ({
    // The table's OWN row key — `enemyRows` in metrics/damageDone.ts builds the
    // same string — so a band and the row it decomposes are one key rather than
    // two spellings of one enemy.
    key: `enemy:${JSON.stringify(series.enemyType)}`,
    label: enemyName(series.enemyType),
    values: series.values,
  }));
};
