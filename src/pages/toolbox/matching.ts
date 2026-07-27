/** True when each filter can be assigned its own DISTINCT item accepted by
 * `ok` (backtracking assignment; both lists are small — ≤4 in practice). */
export const assignable = <F, M>(items: M[], filters: F[], ok: (f: F, m: M) => boolean): boolean => {
  const used = new Array<boolean>(items.length).fill(false);
  const assign = (fi: number): boolean => {
    if (fi === filters.length) return true;
    for (let ri = 0; ri < items.length; ri++) {
      if (used[ri] || !ok(filters[fi], items[ri])) continue;
      used[ri] = true;
      if (assign(fi + 1)) return true;
      used[ri] = false;
    }
    return false;
  };
  return assign(0);
};
