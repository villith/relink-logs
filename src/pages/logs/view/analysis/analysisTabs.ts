import { ChartBarHorizontal, ListBullets, Table } from "@phosphor-icons/react";

import type { MetricTab } from "./MetricTabs";
import { METRICS } from "./model/useRowModel";

/** The switcher's contents, derived from `METRICS` — each descriptor already
 * carries the label the tab shows, and two lists that must agree is one list
 * too many. Insertion order there is the display order. */
export const METRIC_TABS: MetricTab[] = Object.entries(METRICS).map(([value, descriptor]) => ({
  value,
  labelKey: descriptor.labelKey,
}));

/** The raw-event-stream view's value in the top-level switch, and in the `tab`
 * URL param. Its absence means the default view, the table. */
export const EVENTS_TAB = "events";
/** The positional view: the metric's own rows drawn against fight time. */
export const TIMELINE_TAB = "timeline";
/** The default view: the chart-and-table body, everything the metric tabs
 * switch between. Never written to the URL — a default in the URL is noise. */
export const TABLE_TAB = "table";

/** The top-level switch, which changes the WHOLE body below the selector bar.
 *
 * Neither Events nor Timeline is a metric — they have no chart of their own, no
 * groupings and no numeric columns, so there is nothing for
 * `CAPABILITIES`/`resolveViewSpec` to answer for them. Both ride the `tab`
 * param instead of `state.metric`, so the pins survive switching between the
 * three bodies — which is the point of sharing the selector bar.
 *
 * The icons are what tells this row apart from the metric tabs a few pixels
 * away, which deliberately carry none. */
export const VIEW_TABS: MetricTab[] = [
  { value: TABLE_TAB, labelKey: "ui.logs.view-table-tab", icon: Table },
  { value: TIMELINE_TAB, labelKey: "ui.logs.timeline-tab", icon: ChartBarHorizontal },
  { value: EVENTS_TAB, labelKey: "ui.logs.events-tab", icon: ListBullets },
];

/** The `tab` param resolved to one of the three bodies, with anything
 * unrecognised falling back to the default. One selector rather than a boolean
 * per body: two booleans can both be true, and which one won would then depend
 * on the order the JSX happened to test them in.
 *
 * Read by the FRAME, which draws the switch, and by every pane, which draws the
 * body — one author, so a pane can never render a body the switch does not
 * show as selected. */
export const bodyFor = (tab: string | null): string =>
  tab === EVENTS_TAB ? EVENTS_TAB : tab === TIMELINE_TAB ? TIMELINE_TAB : TABLE_TAB;
