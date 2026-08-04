/** Files `items` under `key`, preserving first-seen order.
 *
 * The one spelling of an idiom the view layer had re-derived in half a dozen
 * places — ability rows, status rows, hover-card sections. Insertion order is
 * part of the contract: several callers rely on it to keep rows in the order
 * the encounter produced them rather than a hash order.
 */
export const groupBy = <K, T>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    // Computed once: `key` often builds a template string per item, and calling
    // it twice per item doubled that on every render.
    const itemKey = key(item);
    const group = groups.get(itemKey);
    if (group) group.push(item);
    else groups.set(itemKey, [item]);
  }
  return groups;
};
