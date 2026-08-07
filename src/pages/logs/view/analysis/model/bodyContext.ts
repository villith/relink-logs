import type React from "react";

import type { EventPins } from "../../events/eventRows";
import type { ScopeProbes } from "../../events/eventScope";
import type { Hostility, MetricRow } from "../../metrics/types";
import type { SelectorPins } from "../../selectorOptions";
import type { CardAmount, CardSection } from "../HoverCard";
import type { MetricKey } from "../machine/state";

/** What a body needs to read the RAW EVENT STREAM: which log, which metric,
 * which side, and how to narrow and classify what comes back.
 *
 * Events and Timeline take it; the table reads no events at all. One object
 * rather than five props threaded to each, so the two cannot be handed
 * different pins or different probes — which is what would let the timeline's
 * marks and the events list disagree about the same fight. */
export type StreamContext = {
  id: string | undefined;
  metric: MetricKey;
  hostility: Hostility;
  pins: EventPins;
  probes: ScopeProbes;
};

/** What a body needs to DRAW the metric's rows.
 *
 * Table and Timeline take it. One object rather than eight props threaded to
 * each separately: the two must draw one row identically — the same name, the
 * same art, the same colour, the same card — and handing them separate
 * resolvers is precisely how they would come to differ.
 *
 * `rows` is the shown form, with provenance cells already prepended where the
 * effect level applies, so neither body has to know that rule. */
export type RowPresentation = {
  rows: MetricRow[];
  renderLabel: (row: MetricRow) => React.ReactNode;
  rowColor: (row: MetricRow) => string;
  onPin: (pins: Partial<SelectorPins>) => void;
  rowSections?: (row: MetricRow) => CardSection[] | null;
  /** What the card's figures MEASURE. Absent, no card is drawn at all — the
   * rule both bodies already follow. */
  cardAmount?: CardAmount;
  /** A section name per row, for rows that group into titled runs. */
  sectionLabel?: (row: MetricRow) => string | null;
  /** What an empty body says, where "clear a pin" is not the honest reason. */
  emptyKey?: string;
};
