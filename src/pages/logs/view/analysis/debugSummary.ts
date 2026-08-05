/** What the plot was actually drawn from, as opposed to what the pins ask for.
 *
 * The two come apart in ways nothing on screen shows: a scoped refetch whose
 * metric has no decomposition still draws the base load's curves, a drill folds
 * its own series over its own length, and an ability pin that expands to no
 * actions narrows the fetch to nothing. */
export type ChartDebugFacts = {
  /** The selected metric tab's key. */
  metric: string;
  /** Row level the pins put the table at — players, abilities, skills. */
  level: string;
  /** Which series the plot is drawn from. `stacks` is the status drill: one
   * series per holder of the pinned effect, plotting stack depth rather than
   * any of the three damage-shaped sources. `enemy` is the enemy side's own
   * decomposition, one band per enemy type, which replaces the drill there. */
  chart: "base" | "scoped" | "drill" | "stacks" | "enemy";
  /** Series (legend entries) plotted. */
  series: number;
  /** Buckets the series were built over. */
  len: number;
  /** Buckets actually handed to the chart, after the window slice. */
  shown: number;
  /** Committed window as [start, end] bucket indexes; null is the full fight. */
  window: [number, number] | null;
  /** Whether a scoped refetch is in hand at all. */
  scoped: boolean;
  /** Target spans sent with the scoped fetch. */
  spans: number;
  /** Raw action ids the ability pin expanded to. */
  actions: number;
  /** Status bands shaded onto the plot. */
  bands: number;
};

/** One line of `key=value` pairs, in a fixed order so two readings can be
 * compared by eye. */
export const formatChartDebug = (facts: ChartDebugFacts): string =>
  [
    `metric=${facts.metric}`,
    `level=${facts.level}`,
    `window=${facts.window === null ? "full" : `${facts.window[0]}-${facts.window[1]}`}`,
    `chart=${facts.chart}`,
    `series=${facts.series}`,
    `len=${facts.len}`,
    `shown=${facts.shown}`,
    `scoped=${facts.scoped ? 1 : 0}`,
    `spans=${facts.spans}`,
    `actions=${facts.actions}`,
    `bands=${facts.bands}`,
  ].join(" ");
