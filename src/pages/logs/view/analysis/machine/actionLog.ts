import { encodeState, type AnalysisState } from "./state";

/** What the recorder watches: the machine state plus the body switch.
 *
 * `tab` is not part of `AnalysisState` (see AnalysisView — neither Events nor
 * Timeline is a metric), but it is a URL key the user changes by clicking, and
 * a trail that silently omitted "they switched to the timeline" would describe
 * a different session than the one being reported. */
export type RecordedState = AnalysisState & { tab: string | null };

/** One field's move across a single transition. */
export type FieldDelta = { field: string; from: string; to: string };

/** One recorded step.
 *
 * `opened` is the landing snapshot rather than a move — a report from a shared
 * or hand-edited address has to say where the session STARTED, or every delta
 * after it is measured from an unknown origin. */
export type ActionEntry =
  | { kind: "opened"; seq: number; atMs: number; summary: string; query: string }
  | { kind: "change"; seq: number; atMs: number; deltas: FieldDelta[]; query: string };

/** How an absent pin, an empty filter or an unset window is spelled. A readout
 * that left them blank would print `src=` and leave the reader deciding whether
 * that is "no pin" or "the formatter broke". */
const NONE = "—";

const list = (values: string[]): string => (values.length === 0 ? NONE : values.join(","));
const num = (value: number | null): string => (value === null ? NONE : String(value));

/** Every watched field, in the order a delta list prints them: which body,
 * which metric, which side, the grouping override, then the three pins in drill
 * order, then the filters. Fixed rather than "whichever changed first", because
 * a stable order is what lets two reports be compared by eye.
 *
 * The names are the URL's own (`src`, `abil`, `tgt`, `by`) so a line can be
 * read straight against the query string printed above it. The exception is the
 * scrub window: the URL spells it `from`/`to` across two params, and calling it
 * `window` here would sit one character away from `win`, the battle-window
 * FILTER — two different narrowings that must never be confused. It is `zoom`,
 * which is what the view's own vocabulary calls it. */
const FIELDS: { field: string; read: (state: RecordedState) => string }[] = [
  // Verbatim, defaulting only a MISSING tab: a hand-typed `tab=bogus` reads as
  // the table but must print as itself, since explaining odd behaviour is the
  // whole job of the readout.
  { field: "tab", read: (state) => state.tab ?? "table" },
  { field: "metric", read: (state) => state.metric },
  { field: "side", read: (state) => state.hostility },
  { field: "by", read: (state) => state.by ?? NONE },
  { field: "src", read: (state) => num(state.source) },
  { field: "abil", read: (state) => state.ability ?? NONE },
  { field: "tgt", read: (state) => num(state.target) },
  { field: "zoom", read: (state) => (state.window === null ? NONE : `${state.window[0]}-${state.window[1]}`) },
  { field: "aura", read: (state) => list(state.aura) },
  { field: "win", read: (state) => list(state.win) },
];

/** Every field that moved between two snapshots, or an empty list if none did.
 *
 * One call is one USER ACTION, however many fields it touched: the hostility
 * switch clears both actor pins, any pin clears the grouping override, and a
 * window chip commits a scrub alongside itself. Splitting those into an entry
 * each would report three clicks where there was one.
 *
 * It deliberately does NOT guess which field was the one clicked. That is not
 * recoverable from a diff, and a confident wrong guess in a bug report costs
 * more than the ambiguity it hides. */
export const describeTransition = (prev: RecordedState, next: RecordedState): FieldDelta[] =>
  FIELDS.map(({ field, read }) => ({ field, from: read(prev), to: read(next) })).filter(
    (delta) => delta.from !== delta.to
  );

/** Every field's value on one line — the opened entry's payload. */
export const summarizeState = (state: RecordedState): string =>
  FIELDS.map(({ field, read }) => `${field}=${read(state)}`).join(" ");

/** The query string this state would write, leading "?" and all, "" for none.
 *
 * Derived from the state rather than sampled from the address bar. nuqs
 * throttles the real URL write, so reading the live query at the moment a
 * transition lands can record the PREVIOUS address beside the new state — and a
 * replay trail whose steps are each one behind is worse than none.
 *
 * Field order matches `RawState`, with the body last, so two entries differing
 * in one pin differ in one place. */
export const queryOf = (state: RecordedState): string => {
  const raw = encodeState(state);
  const params = new URLSearchParams();
  const put = (key: string, value: string | null) => {
    if (value !== null) params.set(key, value);
  };
  put("metric", raw.metric);
  put("side", raw.side);
  put("src", raw.src);
  put("tgt", raw.tgt);
  put("abil", raw.abil);
  put("from", raw.from);
  put("to", raw.to);
  put("by", raw.by);
  put("aura", raw.aura);
  put("win", raw.win);
  put("tab", state.tab);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
};

/** One `label   value` line of the state block above the trail. */
export type ReportLine = { label: string; value: string };

export type ReportInput = {
  /** The live query string, verbatim — what `DebugBar` prints. */
  query: string;
  /** The resolved-state block, built by the view. */
  readout: ReportLine[];
  entries: ActionEntry[];
  /** How many entries the ring buffer discarded before the first one held. */
  dropped: number;
};

/** Width of the label column, sized to the longest label a line uses. */
const LABEL = 8;
const label = (text: string): string => text.padEnd(LABEL);

/** A query as it prints: an empty one is named, never left as a bare label. */
const queryText = (query: string): string => (query === "" ? "(none)" : query);

/** A step's offset from the session start. Shared with the panel so the trail
 * on screen and the pasted report stamp one action identically. */
export const actionStamp = (atMs: number): string => `+${(atMs / 1000).toFixed(1)}s`;

/** What one step SAYS: the landing summary, or a row per field that moved.
 *
 * Shared with the panel, which prints these rows and leaves the query to the
 * pasted report. One author, so the two surfaces cannot describe the same
 * action differently. */
export const entryRows = (entry: ActionEntry): ReportLine[] =>
  entry.kind === "opened"
    ? [{ label: "opened", value: entry.summary }]
    : entry.deltas.map((delta) => ({ label: delta.field, value: `${delta.from} → ${delta.to}` }));

/** The rows one entry prints in the report: what it says, then the query it
 * produced — which the panel omits and a replay needs. */
const rowsOf = (entry: ActionEntry): ReportLine[] => [
  ...entryRows(entry),
  { label: "query", value: queryText(entry.query) },
];

/** One entry as text: the first row carries the number and the stamp, the rest
 * hang under it at the head's own width so a multi-delta action reads as one
 * block rather than as several actions sharing a timestamp. */
const formatEntry = (entry: ActionEntry): string => {
  const head = `${String(entry.seq).padStart(3)} ${actionStamp(entry.atMs)} `.padEnd(10);
  const indent = " ".repeat(head.length);
  return rowsOf(entry)
    .map((row, index) => `${index === 0 ? head : indent}${label(row.label)}${row.value}`)
    .join("\n");
};

/** The whole panel as one pasteable block: what the view is asking for now,
 * then how the user got there. */
export const formatReport = ({ query, readout, entries, dropped }: ReportInput): string => {
  const header = [
    "RELINK ANALYSIS DEBUG",
    `${label("query")}${queryText(query)}`,
    ...readout.map((line) => `${label(line.label)}${line.value}`),
  ];
  const trail = [
    `ACTIONS (${entries.length})`,
    // Stated rather than left implicit: a truncated trail that reads as a
    // complete one sends the reader looking for a cause in the wrong steps.
    ...(dropped > 0 ? [`  … ${dropped} earlier actions dropped`] : []),
    ...(entries.length === 0 ? ["  (nothing recorded)"] : entries.map(formatEntry)),
  ];
  return [...header, "", ...trail].join("\n");
};
