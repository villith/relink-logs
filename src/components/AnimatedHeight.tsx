import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** How long the box takes to travel between two content heights. Short enough
 * to keep up with a cursor crossing a plot, long enough to read as one box
 * changing rather than as a different box. */
const DURATION_MS = 120;

/**
 * A box that TRAVELS between its content's heights instead of jumping.
 *
 * For content that is re-rendered wholesale as the pointer moves — the chart
 * tooltip, whose sections come and go per bucket: a second holding an SBA
 * window and a death marker draws two more sections than the second beside it,
 * and the card snapped taller and shorter as the cursor crossed the plot.
 * Reserving slots fixes the rows (see `CardSection.reserve`) but cannot fix
 * this: the sections themselves are the thing appearing.
 *
 * Height is measured rather than transitioned from `auto`, which no browser
 * interpolates for content-driven changes. Two behaviours are load-bearing:
 *
 * - An UNMEASURABLE box (zero height) leaves the height unset. The wrapper
 *   clips, so committing a zero would hide the content outright — which is
 *   what every jsdom test would see, since jsdom lays nothing out.
 * - The opening frame does not animate, and needs no flag to say so: it goes
 *   from `auto` to a length, and `auto` is not a value a transition can
 *   interpolate from. Only the length-to-length changes after it travel.
 */
export const AnimatedHeight = ({ children }: { children: ReactNode }) => {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  // No dep array: the content is rebuilt by the parent on every pointer frame
  // and this has to re-measure whatever came in. Safe to run every render only
  // because the update below bails when nothing moved — the same guard, and
  // for the same unbounded-loop reason, as `CursorCard`'s own measurement.
  useLayoutEffect(() => {
    const measured = content.current?.getBoundingClientRect().height ?? 0;
    if (measured === 0) return;
    setHeight((previous) => (previous !== null && Math.abs(previous - measured) < 0.5 ? previous : measured));
  });

  return (
    <div
      style={{ overflow: "hidden", transition: `height ${DURATION_MS}ms ease`, ...(height === null ? {} : { height }) }}
    >
      <div ref={content}>{children}</div>
    </div>
  );
};
