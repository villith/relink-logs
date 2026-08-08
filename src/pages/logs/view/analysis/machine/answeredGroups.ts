import type { GroupAggregate } from "@/types";

import type { Dimension } from "./state";

/** Group aggregates, paired with the grouping they actually answer. */
export type AnsweredGroups = {
  groups: GroupAggregate[];
  groupBy: Dimension;
};

/** The aggregates the view should render, and WHICH GROUPING THEY ANSWER.
 *
 * The requested grouping (`spec.groupBy`) flips the instant the regroup tab is
 * clicked; the aggregates that answer it arrive a fetch later. Reading the
 * aggregates in hand as though they answered the new question is what made the
 * chart flicker: switching Damage Done from "done by player" to "done by
 * ability" stacked the previous response's PLAYER aggregates as if they were
 * abilities, so the plot's outer shape stayed right — the same fight, so the
 * same total — while every band inside it was the wrong decomposition, until
 * the response landed and it settled.
 *
 * So the answer travels WITH the data. Downstream, the chart derives itself
 * from `groupBy` here rather than from the requested one, which means a
 * regroup holds the previous plot until its own aggregates arrive and then
 * changes once. The requested grouping still drives the FETCH — this is only
 * about what may be drawn before it returns.
 *
 * `requested` is the fallback wherever a fetch carried no group query at all —
 * the non-groups metrics, and first paint. Its aggregate list is empty in
 * every such case, so it draws nothing whichever grouping it is read as. */
export const answeredGroups = (
  /** The scoped fetch's response, or null while the base load's still stands.
   * Its own `groupBy` is null when that request carried no group query. */
  scoped: { groups: GroupAggregate[]; groupBy: Dimension | null } | null,
  /** The base load's, under the same rule. */
  base: { groups: GroupAggregate[]; groupBy: Dimension | null },
  requested: Dimension
): AnsweredGroups => {
  const answered = scoped ?? base;
  return { groups: answered.groups, groupBy: answered.groupBy ?? requested };
};
