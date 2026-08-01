/** Plot geometry in client pixels, plus the last bucket index. */
export type PlotGeometry = { left: number; width: number; maxIndex: number };

/** Minimum drag in pixels before it counts as a selection rather than a click. */
const MIN_DRAG_PX = 4;

/** Turn a drag between two client-X positions into a `[start, end]` bucket
 * range, or null if it was really a click.
 *
 * Returning null matters: committing a zero-width window would reparse the
 * meter over no events and blank the table. */
export const dragToRange = (fromX: number, toX: number, geometry: PlotGeometry): [number, number] | null => {
  if (Math.abs(toX - fromX) < MIN_DRAG_PX) return null;
  // A plot measured before layout has no width; dividing by it would put NaN
  // into the window.
  if (geometry.width <= 0) return null;

  const toIndex = (x: number) => {
    const ratio = (x - geometry.left) / geometry.width;
    return Math.round(Math.min(1, Math.max(0, ratio)) * geometry.maxIndex);
  };

  const a = toIndex(fromX);
  const b = toIndex(toX);
  return a <= b ? [a, b] : [b, a];
};
