import type { GroupAggregate } from "@/types";

import type { Hostility } from "../../metrics/types";
import type { Dimension, MetricKey } from "./state";

/** WHAT a set of aggregates is a measurement of.
 *
 * Metric and side together decide what the numbers MEAN — Damage Done and
 * Damage Taken are different quantities, and a side swap re-roles both actor
 * dimensions. The pins, the window and the grouping only decide which slice of
 * one meaning is being read, which is why they are not in here: holding the
 * previous slice while the next one loads is useful, and holding a different
 * quantity is a lie. */
export type GroupReading = { metric: MetricKey; hostility: Hostility };

/** One response's aggregates and the question they answer: the reading, and the
 * grouping within it. Both are null where the request carried no group query at
 * all — every non-groups metric, and first paint. */
export type GroupAnswer = {
  groups: GroupAggregate[];
  groupBy: Dimension | null;
  reading: GroupReading | null;
};

/** What the view asked for. */
export type GroupRequest = {
  groupBy: Dimension;
  /** Null on a metric with no group query — the aura tabs, Stun and SBA. */
  reading: GroupReading | null;
};

export type AnsweredGroups = {
  groups: GroupAggregate[];
  groupBy: Dimension;
  /** Whether these aggregates answer the request. False means a fetch is still
   * out and what is in hand answers something else — the pane holds its previous
   * render rather than drawing these (see `AnalysisPane`). */
  settled: boolean;
};

const sameReading = (a: GroupReading | null, b: GroupReading | null): boolean =>
  a !== null && b !== null && a.metric === b.metric && a.hostility === b.hostility;

/** The aggregates the view should render, and WHICH QUESTION THEY ANSWER.
 *
 * The request flips the instant a tab or a regroup is clicked; the aggregates
 * that answer it arrive a fetch later. Reading whatever is in hand as though it
 * answered the new question is what made the view flicker, in two ways that took
 * two goes to see:
 *
 * * **Wrong decomposition.** Regrouping Damage Done from "done by player" to
 *   "done by ability" stacked the previous response's PLAYER aggregates as if
 *   they were abilities: the plot's outer shape stayed right — the same fight,
 *   so the same total — while every band inside it was wrong, until the response
 *   landed and it settled. That is what `groupBy` here fixes.
 * * **Wrong quantity.** Stun and SBA send no group query, so their `groups` fell
 *   all the way back to the BASE load's — which answer Damage Done. Switching
 *   from Stun to Damage Taken then rendered Damage Done's aggregates as Taken
 *   rows, grouped by source, matching the requested grouping exactly and so
 *   reading as fully settled. Only the numbers were another metric's. That is
 *   what `reading` fixes.
 *
 * So the answer travels WITH the data, and a response that answers a different
 * reading is not a stale slice to hold — it is not an answer at all, and reports
 * no aggregates rather than another metric's.
 *
 * The scoped response is preferred where BOTH answer the request; where only one
 * does, that one wins. A scoped fetch left over from the previous tab answers
 * nothing (a non-groups metric stamps no reading), so a switch back to the
 * metric the base load happens to carry is served by the base load rather than
 * being made to wait for a fetch that would return the same rows. */
export const answeredGroups = (
  /** The scoped fetch's response, or null while the base load's still stands. */
  scoped: GroupAnswer | null,
  /** The base load's, under the same rule. */
  base: GroupAnswer,
  request: GroupRequest
): AnsweredGroups => {
  const answering = [scoped, base].find((held): held is GroupAnswer =>
    sameReading(held?.reading ?? null, request.reading)
  );

  // Nothing in hand measures what was asked for. Empty rather than "the closest
  // thing we have": the caller can hold its previous render, and it cannot do
  // that if it is handed plausible-looking numbers from another metric.
  if (answering === undefined) return { groups: [], groupBy: request.groupBy, settled: false };

  const groupBy = answering.groupBy ?? request.groupBy;
  return { groups: answering.groups, groupBy, settled: groupBy === request.groupBy };
};
