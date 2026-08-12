import type { EventRow } from "./eventRows";

/** A row that may hang under another, or be drawn only to hold one up. */
export type NestedEventRow = EventRow & {
  /** Present on an echo drawn under its trigger. Absent on every other row,
   * including an echo whose trigger this page never carried. */
  parent?: {
    /** Milliseconds after the trigger. The row shows this instead of an
     * absolute stamp, so the time column never reads backwards — a child is
     * not claiming a position on the timeline. `timeMs` still holds the real
     * one, for the hover. */
    deltaMs: number;
    /** The echo as a percentage of its trigger's damage, to one decimal. The
     * quantity the pairing evidence turns on: a hit at the damage cap procs
     * at exactly 60.0%. */
    sharePercent: number;
  };
  /** A trigger re-admitted past a filter purely so its echo has something to
   * hang from. Drawn dimmed; it is context, not a match. */
  context?: true;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The echo, restated as an offset from the hit that caused it. */
const asChild = (echo: EventRow, trigger: EventRow): NestedEventRow => ({
  ...echo,
  parent: {
    deltaMs: echo.timeMs - trigger.timeMs,
    // A trigger with no amount is not a trigger anybody can read a share
    // against — 0 rather than the NaN or Infinity the division would give,
    // which would render as a number that means nothing.
    sharePercent: trigger.amount ? round1(((echo.amount ?? 0) / trigger.amount) * 100) : 0,
  },
});

/** Supplementary rows moved to sit under the hits that caused them.
 *
 * An echo lands ~151ms after its trigger, and in a real fight that is about
 * nine damage events later — so annotating it in place would mean an arrow
 * pointing nine rows up the page, and an arrow nobody follows is not a link.
 * Moving the row is what makes the pair legible: the reader sees the hit and
 * what it echoed as one thing, without holding a position in their head.
 *
 * The move costs the child its place on the timeline, so the child does not
 * claim one. It shows `parent.deltaMs` — its offset from the row above —
 * leaving the absolute column strictly ascending, which is the property that
 * makes the stream scannable at all. Its own `timeMs` is untouched for the
 * hover, so nothing is actually hidden.
 *
 * Showing an echo pulls its trigger back in even when a filter excluded it,
 * drawn dimmed (`context`) rather than as a match: a half-drawn pair says less
 * than either row alone. The pull runs one way only — a filtered-out echo
 * leaves its trigger exactly where the filter left it.
 *
 * `shown` is what the filters left, `all` is the unfiltered page, and `pairs`
 * maps an echo's index in `all` to its trigger's. Output is in `all`'s order,
 * with each nested echo lifted out of its own position. */
export const nestSupplementary = (
  shown: EventRow[],
  all: EventRow[],
  pairs: Record<number, number>
): NestedEventRow[] => {
  // `pairs` speaks in indexes into `all`, so visibility has to be answered in
  // the same terms. `shown` is a SUBSEQUENCE of `all` — `narrowStream` is a
  // chain of `.filter`s over this very array, which keeps both the identities
  // and the order — so one forward walk resolves every index without hashing
  // 50,000 rows on each filter toggle.
  const visible = new Set<number>();
  let at = 0;
  for (let index = 0; index < all.length && at < shown.length; index++) {
    if (all[index] === shown[at]) {
      visible.add(index);
      at++;
    }
  }

  // Every shown row has to have been found, or the walk was resolving against
  // the wrong array and its answers mean nothing: one row that is not `all`'s
  // own object stalls the cursor, and every row after it reads as filtered out.
  // Nesting is the nicety here and the rows are the job, so a broken assumption
  // costs the page its nesting rather than its contents. It cannot happen while
  // `narrowStream` only ever filters — which is why this is a guard and not a
  // slower lookup.
  if (at < shown.length) return shown;

  // Which echoes nest, and under whom. Only a VISIBLE echo nests — and only it
  // can conscript a trigger.
  const children = new Map<number, number[]>();
  const nested = new Set<number>();
  for (let index = 0; index < all.length; index++) {
    if (!visible.has(index)) continue;
    const trigger = pairs[index];
    // Not paired, off this page, or pointing at itself: the row stays where it
    // is, flat, rather than hanging from something that was never shipped.
    if (typeof trigger !== "number" || trigger === index) continue;
    if (!Number.isInteger(trigger) || trigger < 0 || trigger >= all.length) continue;
    nested.add(index);
    const siblings = children.get(trigger);
    if (siblings) siblings.push(index);
    else children.set(trigger, [index]);
  }

  const out: NestedEventRow[] = [];
  const emitted = new Set<number>();

  // Children follow their trigger wherever it lands, recursively — a chain
  // stays under the row that started it. `emitted` is set before recursing, so
  // a link that loops back stops instead of running forever.
  const emitChildren = (parentIndex: number) => {
    for (const child of children.get(parentIndex) ?? []) {
      if (emitted.has(child)) continue;
      emitted.add(child);
      out.push(asChild(all[child], all[parentIndex]));
      emitChildren(child);
    }
  };

  for (let index = 0; index < all.length; index++) {
    if (nested.has(index) || emitted.has(index)) continue;
    const anchors = children.has(index);
    if (!visible.has(index) && !anchors) continue;
    emitted.add(index);
    // Passed through unchanged where nothing was added: over a 50,000-event
    // page most rows are neither parent nor child, and a copy each would be
    // 50,000 allocations that say the same thing.
    out.push(visible.has(index) ? all[index] : { ...all[index], context: true });
    emitChildren(index);
  }

  // `pairs` comes off the wire, and a cycle in it would leave every row of the
  // cycle waiting for another to be placed first. Anything still owed goes out
  // flat, so a bad link degrades to an un-nested row and never to a lost one.
  for (let index = 0; index < all.length; index++) {
    if (!visible.has(index) || emitted.has(index)) continue;
    emitted.add(index);
    out.push(all[index]);
  }

  return out;
};
