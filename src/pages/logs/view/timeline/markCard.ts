import type { CardSection } from "../analysis/HoverCard";

import type { LaneMark } from "./laneMarks";

/** How a mark's parts are named and pictured. Supplied by the view, which
 * already owns these resolvers for its table and its event stream — a second
 * spelling here would let one action be named two ways. */
export type MarkCardContext = {
  /** The lane's own colour, so the card's bars match the marks they explain. */
  color: string;
  entry: (key: string) => { name: string; iconUrl?: string };
};

/** The heading over a mark's breakdown. */
const HEADING_KEY = "ui.logs.timeline-mark-section";

/** One mark's contributions as a card section.
 *
 * EMPTY for a mark with no parts — a status row's real span is not an event
 * fold and has nothing to decompose. `HoverCard` renders its child alone when
 * every section is empty, so this is also how a span mark ends up with no card
 * rather than an empty one.
 *
 * The order is `LaneMark.by`'s own, which `mergeMarks` already sorted largest
 * first; re-sorting here would put the ordering rule in two places. */
export const markCardSections = (mark: LaneMark, ctx: MarkCardContext): CardSection[] => {
  if (mark.by.length === 0) return [];
  return [
    {
      headingKey: HEADING_KEY,
      color: ctx.color,
      entries: mark.by.map((part) => {
        const { name, iconUrl } = ctx.entry(part.key);
        return { key: part.key, label: name, value: part.amount, ...(iconUrl === undefined ? {} : { icon: iconUrl }) };
      }),
    },
  ];
};
