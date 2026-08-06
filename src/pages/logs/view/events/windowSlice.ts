/** Which row indexes to render for a scroll position.
 *
 * Fixed row height by design: it makes the mapping from scroll offset to row
 * index pure arithmetic, so this is testable without a DOM and a long fight's
 * five-figure event count costs nothing to scroll. */
export const visibleSlice = ({
  scrollTop,
  viewportHeight,
  rowHeight,
  total,
  overscan,
}: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  total: number;
  overscan: number;
}): { start: number; end: number } => {
  if (total === 0) return { start: 0, end: 0 };

  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight);

  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + visible + overscan),
  };
};
