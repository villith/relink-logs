/** A drag's two bucket indexes reduced to a window, or null for the full fight.
 *
 * Both indexes come from recharts' `activeTooltipIndex`, which is already the
 * bucket under the pointer — there is no pixel arithmetic here, and no need to
 * know the plot's geometry. That is the whole reason this replaced the old
 * `dragRange`, which measured the chart with getBoundingClientRect() and two
 * guessed inset constants. */
export const windowFromDrag = (a: number, b: number, maxIndex: number): [number, number] | null => {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (from === to) return null;
  if (from <= 0 && to >= maxIndex) return null;
  return [from, to];
};
