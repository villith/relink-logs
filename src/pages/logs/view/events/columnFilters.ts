import type { EventRow } from "./eventRows";

/** How a column's values get their name and art. Structural rather than an
 * import of `EventLabels`, which lives in the component that consumes this
 * module — the other direction would be a cycle. `EventLabels` satisfies it as
 * it stands. */
export type ColumnNaming = {
  ability: (key: string) => { name: string; iconUrl?: string };
  status: (key: string) => { name: string; iconUrl?: string };
  actor: (index: number, atMs: number, space: "actor" | "spawn") => { name: string; iconUrl?: string };
};

/** The three columns a row can be narrowed by. Time is not one of them — a
 * moment is not a value you tick off a list — and amount is a measurement
 * rather than a name. */
export type EventColumn = "source" | "ability" | "target";

/** What a row carries in one column, as a string, or null where it carries
 * nothing there.
 *
 * A STRING and not the raw number, because the three columns key on three
 * different things and one filter has to hold any of them: an ability is
 * already a key, a source is an index, and a target is an index that means
 * nothing without the space it is in (see `ActorSpace`) — the two capture paths
 * do not share one, so `9` alone names two different enemies. */
export const columnToken = (row: EventRow, column: EventColumn): string | null => {
  if (column === "source") return row.sourceIndex === null ? null : String(row.sourceIndex);
  if (column === "ability") return row.abilityKey ?? row.statusKey;
  return row.targetIndex === null ? null : `${row.targetSpace}:${row.targetIndex}`;
};

/** One line of a column's menu: what to call it, how many rows it keeps, and
 * every token that answers to that name. */
export type ColumnOption = {
  label: string;
  count: number;
  iconUrl?: string;
  /** Plural because the menu is deduped by NAME, so one line can stand for two
   * values the game names identically. */
  tokens: string[];
};

/** Which values are ticked per column. An absent — or empty — set is no filter
 * on that column at all. */
export type ColumnFilters = Partial<Record<EventColumn, ReadonlySet<string>>>;

/** How a column's values are named and pictured. */
const nameIn = (row: EventRow, column: EventColumn, naming: ColumnNaming): { name: string; iconUrl?: string } => {
  if (column === "ability") {
    // The row's own split: an ability names itself, an effect is named through
    // the `status:` grammar the buffs tables pin, and the column shows both.
    return row.abilityKey !== null ? naming.ability(row.abilityKey) : naming.status(row.statusKey ?? "");
  }
  if (column === "source") {
    // Always the ACTOR space — a damage event's `source.parent_index` is the
    // same index a spawn's `actorIndex` is.
    return naming.actor(row.sourceIndex ?? 0, row.timeMs, "actor");
  }
  return naming.actor(row.targetIndex ?? 0, row.timeMs, row.targetSpace);
};

/** Everything a column can be narrowed to, most frequent first.
 *
 * Deduped by the name the reader reads, because that is what the menu shows and
 * two lines wearing one label would be two boxes that look like the same box.
 *
 * Built from the rows the OTHER filters left, so the menu never offers a value
 * that would empty the table — but NOT from the rows this column's own filter
 * left, or ticking one value would delete every other box from the menu that
 * had just been used to tick it. */
export const columnOptions = (rows: readonly EventRow[], naming: ColumnNaming, column: EventColumn): ColumnOption[] => {
  const buckets = new Map<string, ColumnOption>();
  // One resolution per token rather than per row: a stream is capped at fifty
  // thousand events and a menu is rebuilt on every filter change. Sound for the
  // ability column, whose keys are a pure map to names — and for the two actor
  // columns too, because the token carries the space, and a token that named
  // two spawns would already be one the ROWS could not tell apart.
  const named = new Map<string, { name: string; iconUrl?: string }>();

  for (const row of rows) {
    const token = columnToken(row, column);
    if (token === null) continue;

    let cell = named.get(token);
    if (cell === undefined) {
      cell = nameIn(row, column, naming);
      named.set(token, cell);
    }

    const bucket = buckets.get(cell.name);
    if (bucket === undefined) {
      buckets.set(cell.name, { label: cell.name, count: 1, iconUrl: cell.iconUrl, tokens: [token] });
      continue;
    }
    bucket.count += 1;
    if (!bucket.tokens.includes(token)) bucket.tokens.push(token);
    if (bucket.iconUrl === undefined && cell.iconUrl !== undefined) bucket.iconUrl = cell.iconUrl;
  }

  return [...buckets.values()].sort((left, right) => right.count - left.count);
};

/** The rows every filtered column admits.
 *
 * ANDed across columns and ORed within one, which is how a reader reads a set
 * of tick boxes: "these two players, doing this one ability".
 *
 * A row that cannot answer a filtered column is dropped, by the same rule the
 * pins already follow — under a source filter, a party-wide row belongs to
 * nobody, and keeping it would read as the filter failing to apply. */
export const applyColumnFilters = (rows: readonly EventRow[], filters: ColumnFilters): EventRow[] => {
  const active = (Object.entries(filters) as [EventColumn, ReadonlySet<string> | undefined][]).filter(
    ([, picked]) => picked !== undefined && picked.size > 0
  );
  if (active.length === 0) return [...rows];

  return rows.filter((row) =>
    active.every(([column, picked]) => {
      const token = columnToken(row, column);
      return token !== null && picked?.has(token) === true;
    })
  );
};

/** The rows one column's menu should COUNT against: everything the other
 * columns admit, and everything this one does — its own ticks deliberately
 * ignored.
 *
 * The other columns, because a count that ignored them would answer a question
 * nobody asked: with a player already picked, "412" beside an ability is the
 * whole fight's total, not what ticking it would actually leave.
 *
 * Not its own, because a column counted against its own ticks reports zero for
 * every box the reader has NOT ticked — and a zero-count value has no rows, so
 * it drops out of the very menu the reader opened to tick it in. */
export const facetFor = (rows: readonly EventRow[], filters: ColumnFilters, column: EventColumn): EventRow[] => {
  const others = Object.fromEntries(Object.entries(filters).filter(([named]) => named !== column)) as ColumnFilters;
  return applyColumnFilters(rows, others);
};

/** How many columns are actually narrowing anything — what the "clear filters"
 * control reports, and what tells an untouched table from a filtered one. */
export const filteredColumns = (filters: ColumnFilters): number =>
  Object.values(filters).filter((picked) => picked !== undefined && picked.size > 0).length;
