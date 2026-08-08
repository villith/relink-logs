/** The section heading to draw above each item, or null where the run
 * continues.
 *
 * ONE author for a rule two surfaces must apply identically. The table and the
 * timeline draw the same row set — the timeline's name column and its track
 * column draw it twice more — and a heading emitted by one loop but not the
 * next is exactly how those columns come to sit a row out of step.
 *
 * The rule: a heading appears only where the section CHANGES between
 * consecutive items, so a run of rows sharing one is titled once. `sectionOf`
 * is optional because the prop that supplies it is; absent, nothing is titled.
 *
 * Called once per item rather than once per comparison — the accessors behind
 * it resolve a row's provenance through the cause ladder, which is not free. */
export const sectionHeadings = <T>(items: readonly T[], sectionOf?: (item: T) => string | null): (string | null)[] => {
  let previous: string | null = null;
  return items.map((item) => {
    const section = sectionOf?.(item) ?? null;
    const heading = section !== null && section !== previous ? section : null;
    previous = section;
    return heading;
  });
};
