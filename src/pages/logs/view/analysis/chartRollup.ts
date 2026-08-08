import type { ChartDatapoint } from "../DetailCharts";

/** The rollup band's series key. A reserved word like `TOTAL_SERIES_KEY`,
 * matching the key the band labellers already name (`bandLabelFor("other")`),
 * so it can never collide with a real band. */
export const ROLLUP_SERIES_KEY = "other";

/** Whether the rollup band is drawn at all: only while something is inside it. */
export const rollupIsDrawn = (tailKeys: string[], hidden: Set<string>): boolean =>
  tailKeys.some((key) => hidden.has(key));

/** The plot's datapoints with the rollup band recomputed from the tail bands
 * that are currently HIDDEN.
 *
 * The band producers rank every band and mark the ones past the chart's cap as
 * `tail` (see `groupBandsFor`/`abilityBands`). The tail is plotted hidden, and
 * this is what stands in its place: `other`, summing exactly the tail bands
 * still hidden at this moment.
 *
 * That recomputation is the whole mechanism. A fixed rollup — one summing the
 * whole tail whatever the legend says — would be double-counted the instant a
 * greyed-out band was switched on, and the stack would stand that band too
 * tall; slicing the tail away instead, as the chart used to, left it with no
 * series to switch on at all. Recomputed, the stack's height stays equal to
 * the fight's own total through every legend click: a band leaving `other` is
 * exactly the band arriving beside it.
 *
 * The tail bands themselves are left in the data untouched — they are ordinary
 * series that simply are not drawn while hidden. Only `hidden` tail keys count,
 * so hiding a TOP band is a plain hide: it must not reappear inside `other`,
 * which would make the click read as though it had failed.
 *
 * Returns the input array by identity when there is nothing to roll up. This
 * runs on every committed cursor frame, and a fresh array would re-reconcile
 * the whole plot each time the pointer moved across it. */
export const withRollupSeries = (data: ChartDatapoint[], tailKeys: string[], hidden: Set<string>): ChartDatapoint[] => {
  const rolled = tailKeys.filter((key) => hidden.has(key));
  if (rolled.length === 0) return data;

  // Cast for the same reason `chartData` casts in AnalysisView: ChartDatapoint
  // intersects a `timestamp?: string` with a numeric index signature, so no
  // object literal carrying both satisfies it structurally.
  return data.map((point) => ({
    ...point,
    // A band that accrued nothing late in the fight can arrive short of the
    // others; a missing bucket is zero, never NaN.
    [ROLLUP_SERIES_KEY]: rolled.reduce((sum, key) => sum + (point[key] ?? 0), 0),
  })) as unknown as ChartDatapoint[];
};
