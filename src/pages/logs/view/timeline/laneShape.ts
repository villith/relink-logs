import { isActorKind } from "../actorKind";
import type { LabelKind, MetricRow } from "../metrics/types";

/** How a lane draws itself.
 *
 * `buckets` — a bar per run of one ability, with a tick inside per hit.
 * `icons`   — the same bar, carrying the skill's own art at the moment it fired.
 * `spans`   — a real uptime span, drawn as ambient state.
 *
 * The first two draw the SAME fold and differ only in whether the ability can
 * be named by a picture; a lane of one skill already says which skill it is in
 * its row, but a lane that pools a player's whole rotation does not. */
export type LaneShape = "buckets" | "icons" | "spans";

/** What shape a row's lane takes.
 *
 * The rule is what the row IS — the shared `ACTOR_KINDS` reading, which the
 * table's own art follows too. A lane pooling everything one player did cannot
 * name its marks — every bucket is a different skill — so it draws them plain.
 * A lane that IS one ability can put that ability's art on each cast, which
 * turns the drilled-in view into a rotation you can read at a glance.
 *
 * `tableKind` is the view's own (see `useRowModel`), for the rows that do not
 * declare a kind of their own — the derived metrics (stun, SBA, the status
 * tables) leave `MetricRow.kind` undefined and lean on the table's. */
export const laneShapeOf = (row: MetricRow, tableKind?: LabelKind): LaneShape => {
  // A row carrying its own timeline is not an event fold at all — whatever kind
  // it claims, what it has to draw is uptime.
  if (row.timeline !== undefined) return "spans";
  return isActorKind(row.kind ?? tableKind) ? "buckets" : "icons";
};
