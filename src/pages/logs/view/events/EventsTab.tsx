import { Box, Text, UnstyledButton } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/components/ui/cn";
import { EntityIcon } from "@/components/ui/EntityIcon";
import { Label } from "@/components/ui/Label";
import { Strip } from "@/components/ui/Strip";
import type { PlayerData } from "@/types";
import { millisecondsToPreciseElapsedFormat } from "@/utils";

import "../analysis/analysis.css";

import { AnalysisRow } from "../analysis/AnalysisRow";
import {
  CHIP_BUTTON_CLASS,
  CHIP_BUTTON_SELECTED_CLASS,
  CHIP_CLASS,
  CHIP_SELECTED_CLASS,
  CHIP_SWATCH_CLASS,
} from "../analysis/chipAnatomy";
import type { StreamContext } from "../analysis/model/bodyContext";
import { AmountCell } from "./AmountCell";
import type { PlayerCapUp } from "./capBreakdown";
import type { CapLoadout } from "./capSources";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import {
  applyColumnFilters,
  columnOptions,
  facetFor,
  filteredColumns,
  type ColumnFilters,
  type ColumnOption,
  type EventColumn,
} from "./columnFilters";
import { parseTimeInput, rowAtTime, scrollTopFor } from "./eventJump";
import { EventJumpBar } from "./EventJumpBar";
import { toEventRow, type ActorSpace, type EventKind } from "./eventRows";
import { defaultScopeKinds, narrowStream, scopeFor, scopeKinds } from "./eventScope";
import { nestSupplementary, type NestedEventRow } from "./nestSupplementary";
import { useEvents } from "./useEvents";
import { visibleSlice } from "./windowSlice";
import { Figure } from "../../../../components/ui/Figure";

/** One resolved cell: what to call the thing, and what it looks like. `iconUrl`
 * is absent far more often than not — trash mobs have no portrait, and bare
 * kinds (link attacks, echoes, DoT) are not ability casts.
 *
 * `color` is the actor's own party colour where it has one, and absent for
 * everything that is not a party member — an enemy has no slot, and painting it
 * in the fallback slot's colour would make the stream look like one player did
 * everything. */
export type EventCell = { name: string; iconUrl?: string; color?: string };

/** How a row's indexes become names and art. Supplied by the view, which
 * already owns these resolvers for its own table — a second spelling here would
 * let the two name (or picture) one actor two ways. */
export type EventLabels = {
  /** One actor, at either end of a row — the two columns ask the same question
   * and must not answer it two ways. An enemy source was rendering as a bare
   * number while the same enemy in the target column had a name, because they
   * used to be separate resolvers.
   *
   * Named from its index, the SPACE that index is in, AND the moment of the
   * event: the two capture paths key spawns differently (see `ActorSpace`), and
   * the game reissues a dead boss's actor index to a later spawn, so neither
   * the number nor the space alone can say which spawn a row belongs to. */
  actor: (index: number, atMs: number, space: ActorSpace) => EventCell;
  ability: (key: string) => EventCell;
  /** An EFFECT, named and pictured through the same `status:` grammar the buffs
   * tables use — so one effect reads identically in both. */
  status: (key: string) => EventCell;
};

/** One colour per kind. Damage is the neutral bulk; deaths and guards are the
 * things you scan for, so they get the loud ends of the palette. Every kind in
 * `EVENT_KINDS` must appear here, and no two may share a colour — the toggle
 * chips wear these too, so a shared colour makes two filters look like one. */
export const KIND_COLORS: Record<EventKind, string> = {
  damage: "var(--mantine-color-blue-4)",
  stun: "var(--mantine-color-yellow-4)",
  perfectGuard: "var(--mantine-color-teal-4)",
  sba: "var(--mantine-color-violet-4)",
  sbaTick: "var(--mantine-color-dark-2)",
  death: "var(--mantine-color-red-4)",
  status: "var(--mantine-color-lime-4)",
  other: "var(--mantine-color-gray-5)",
};

/** The toggle chip's label per kind. Spelled out rather than kebab-cased from
 * the kind at runtime: a derived key that misses is a chip labelled with its own
 * i18n key, and nothing fails until someone looks at it. */
const KIND_LABEL_KEY: Record<EventKind, string> = {
  damage: "ui.logs.events-kind-damage",
  stun: "ui.logs.events-kind-stun",
  perfectGuard: "ui.logs.events-kind-perfect-guard",
  sba: "ui.logs.events-kind-sba",
  sbaTick: "ui.logs.events-kind-sba-tick",
  death: "ui.logs.events-kind-death",
  status: "ui.logs.events-kind-status",
  other: "ui.logs.events-kind-other",
};

/** Row height in px, and the analysis view's own — `--spacing-row` is
 * `calc(30px * var(--density))` and this is its base. The stream is a body of
 * that view and draws its rows through the same `AnalysisRow` the metric table
 * and the timeline lanes do, so it cannot be a size smaller than they are.
 *
 * A NUMBER and not the token, because `visibleSlice` divides by it and cannot
 * divide by a CSS custom property. It agrees with the token at the only density
 * that exists: `--density` is a static 1 on `:root` with no runtime setter. If
 * a density knob ever ships, this stops tracking the rows it measures and the
 * virtualiser needs a measuring probe instead — there is no way to read the
 * token here, because `@theme inline` emits the unresolved `calc()` and
 * `getComputedStyle` hands back the string. */
const ROW_HEIGHT = 30;
/** The sticky header's height. Subtracted when jumping, because it overlays the
 * top of the list — a row placed without it lands underneath the column names. */
const HEAD_HEIGHT = 28;
/** Rows rendered beyond each edge of the viewport, so a fast scroll does not
 * outrun the render. */
const OVERSCAN = 10;
/** The scroll container's height in px. A constant rather than a measurement:
 * the height is ours to choose, and choosing it means `visibleSlice` needs no
 * ref-measuring dance and no resize observer. Raised with the row height, so
 * the same count of rows fits as before. */
const VIEWPORT_HEIGHT = 540;

/** The five column widths, shared by the header and the rows so the two cannot
 * drift apart. The ability column takes the slack.
 *
 * Target is the widest of the named columns: a spawn is named "<Enemy> #2" off
 * the full translated enemy name, which is routinely longer than a player's
 * label — "Vulkan Bolla Nihilla #2" against "Narmaya".
 *
 * Time and amount both carry a child's elbow as well as their own figure, and
 * amount carries an echo's share beside its digits. Widened for EVERY row
 * rather than only the ones that carry those: the cells are flex items, so a
 * cell that grew to fit its own content would drag the columns beside it left
 * on that row alone, and columns that move per row are not columns. */
const COLUMNS = { time: 92, source: 176, target: 236, amount: 140 };

/** A column's width, in the view's own scale so it grows with everything else. */
const widthOf = (px: number) => `calc(${px}px * var(--density))`;

/** The elbow that says a row hangs from the one above it.
 *
 * ONE declaration for the three cells that wear it. Drawn on the ability alone,
 * the nesting was legible in the middle of the row and invisible at both ends —
 * which is where the two numbers the whole pairing rests on live. */
const Connector = () => (
  // eslint-disable-next-line i18next/no-literal-string -- tree connector glyph, not prose
  <span aria-hidden className="mr-1 shrink-0 text-ink-3">
    └─
  </span>
);

/** One named-and-pictured cell.
 *
 * Inline throughout — spans and an `img`, never a `div` — because the ability
 * cell is rendered inside `AnalysisRow`'s name slot, which is a `<p>`.
 *
 * `title` because these columns are narrow and a name past them ellipsises;
 * hovering is then the only way left to read the rest of it. */
const CellText = ({
  cell,
  name,
  width,
  suffix,
  connector,
}: {
  cell: EventCell;
  /** The column, as `data-cell` — what the tests address a cell by. */
  name: string;
  /** Absent for the ability cell, which takes whatever the row has left. */
  width?: number;
  /** A dimmed qualifier after the name, for a cell whose name alone does not
   * say the whole thing (an effect landing vs the same effect ending). */
  suffix?: string | null;
  connector?: boolean;
}) => {
  // Only a cell that HAS a colour takes one — an actor. Everything else (the
  // time, the ability, the amount) inherits the row's kind colour, which is
  // what still says at a glance what sort of event this is.
  const painted = cell.color === undefined ? undefined : { color: cell.color };

  return (
    <span
      data-cell={name}
      className={cn("relative flex min-w-0 items-center gap-[5px]", width === undefined ? "flex-1" : "shrink-0")}
      style={width === undefined ? undefined : { width: widthOf(width) }}
    >
      {connector === true && <Connector />}
      {cell.iconUrl !== undefined && <EntityIcon src={cell.iconUrl} alt="" />}
      <span data-name className="truncate" title={cell.name} style={painted}>
        {cell.name}
      </span>
      {suffix !== undefined && suffix !== null && suffix !== "" && (
        <Text span size="xs" c="dimmed" className="shrink-0">
          {suffix}
        </Text>
      )}
    </span>
  );
};

/** Nothing ticked. A shared frozen empty set rather than a fresh one per render
 * — a new `Set` every time is a new prop identity every time. */
const EMPTY_PICKED: ReadonlySet<string> = new Set();

/** The per-column funnels, as the table needs them. */
export type ColumnFilterControl = {
  /** Called only when a menu opens — see `ColumnFilterMenu`. */
  options: (column: EventColumn) => ColumnOption[];
  picked: ColumnFilters;
  onChange: (column: EventColumn, picked: ReadonlySet<string>) => void;
};

export type JumpMarks = {
  /** The row the last jump landed on, or null where nothing has been jumped
   * to. */
  current: number | null;
  /** Bumped on every landing, so the arrival mark replays even when the jump
   * ends on a row that was already on screen. */
  arrival: number;
};

export const EventRowsTable = ({
  rows,
  rowHeight,
  startIndex,
  totalRows,
  labels,
  marks,
  filters,
}: {
  /** The visible slice only. */
  rows: NestedEventRow[];
  rowHeight: number;
  /** Absolute index of `rows[0]`, so positions survive scrolling. */
  startIndex: number;
  /** The WHOLE filtered list's length — what the spacer, and therefore the
   * scrollbar, is sized by. */
  totalRows: number;
  labels: EventLabels;
  /** The party's cap-up totals, keyed by the slot key a damage row carries as
   * its `sourceIndex`. Absent for a log recorded before the capture. */
  capUp?: Record<string, PlayerCapUp>;
  /** The party's stored loadouts, on the same key — what the cap card itemizes
   * the totals against. The character is along for the ride because it keys
   * the base-cap ladder the card's independent total comes from. */
  loadout?: Map<number, CapLoadout & Pick<PlayerData, "characterType">>;
  /** How the current jump target paints the rows. Absent, nothing is marked. */
  marks?: JumpMarks;
  /** The per-column funnels. Absent, the heads carry no controls at all — which
   * is what the standalone table tests render. */
  filters?: ColumnFilterControl;
}) => {
  const { t } = useTranslation();

  /** One column head: its name, and the funnel for the three columns that hold
   * values worth ticking off a list. */
  const head = (labelKey: string, width?: number, column?: EventColumn) => (
    <span
      role="columnheader"
      className={cn("flex items-center gap-1", width === undefined ? "flex-1" : "shrink-0")}
      style={width === undefined ? undefined : { width: widthOf(width) }}
    >
      {/* Bigger than the app's default caption voice: these name the columns you
          filter FROM, so they are doing real work rather than captioning. */}
      <Label data-head-label className="truncate text-sm">
        {t(labelKey)}
      </Label>
      {column !== undefined && filters !== undefined && (
        <ColumnFilterMenu
          column={column}
          name={t(labelKey)}
          options={filters.options}
          picked={filters.picked[column] ?? EMPTY_PICKED}
          onChange={(picked) => filters.onChange(column, picked)}
        />
      )}
    </span>
  );

  return (
    <>
      {/* Sticky, and a sibling of the row container rather than inside it: the
          rows are absolutely positioned against that container's own origin, so
          a header within it would sit under row 0. */}
      {/* Flat, with the column heads as its direct children: a wrapper between
          the row and its cells breaks the grid relationship that says these
          five name the five columns below. `data-head` rather than a styling
          class, as in the metric table — the heads and the data rows share
          role="row", so tests need something to tell them apart that survives
          either being restyled. */}
      <Box
        className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-2"
        role="row"
        data-head
        style={{ height: `calc(${HEAD_HEIGHT}px * var(--density))` }}
      >
        {head("ui.logs.events-time", COLUMNS.time)}
        {head("ui.logs.events-source", COLUMNS.source, "source")}
        {head("ui.logs.events-ability", undefined, "ability")}
        {head("ui.logs.events-target", COLUMNS.target, "target")}
        {/* Amount is a MEASUREMENT and time is a moment — neither is a value you
            tick off a list, so neither grows a funnel. */}
        <span role="columnheader" className="flex shrink-0 justify-end" style={{ width: widthOf(COLUMNS.amount) }}>
          <Label className="text-sm">{t("ui.logs.events-amount")}</Label>
        </span>
      </Box>

      <Box data-event-body style={{ position: "relative", height: totalRows * rowHeight }}>
        {rows.map((row, offset) => {
          const rowIndex = startIndex + offset;
          // What the row DID. An ability names itself; an effect is named
          // through the `status:` grammar; a kind with neither has only its
          // descriptor.
          const detail = row.detailKey === null ? null : t(row.detailKey, row.detailParams);
          const action =
            row.abilityKey !== null
              ? labels.ability(row.abilityKey)
              : row.statusKey !== null
                ? labels.status(row.statusKey)
                : { name: detail ?? "" };
          // Both ends of the row, resolved the same way. The source is always in
          // the ACTOR space — a damage event's `source.parent_index` is the same
          // index a spawn's `actorIndex` is — while the target's space is
          // whatever the row declares (see `ActorSpace`).
          const source = row.sourceIndex === null ? { name: "" } : labels.actor(row.sourceIndex, row.timeMs, "actor");
          const target =
            row.targetIndex === null ? { name: "" } : labels.actor(row.targetIndex, row.timeMs, row.targetSpace);
          // An echo's share of the hit that caused it — the quantity the whole
          // pairing rests on. Suppressed at zero, which is what a trigger with
          // no readable amount yields: "0.0%" would read as a measurement
          // rather than the absence of one.
          const share =
            row.parent === undefined || row.parent.sharePercent === 0 ? null : row.parent.sharePercent.toFixed(1);
          const child = row.parent !== undefined;
          const current = marks?.current === rowIndex;

          return (
            <AnalysisRow
              key={`${row.timeMs}:${rowIndex}`}
              data-event-row
              data-jump-current={current ? true : undefined}
              // A trigger pulled back past a filter is context, not a match:
              // dimmed, and it says so on hover rather than looking like a
              // filter that failed to apply.
              title={row.context === true ? t("ui.logs.events-echo-context-title") : undefined}
              className={[
                // The stream's rows carry no magnitude bar behind them, so the
                // shell's hover ring alone reads thinner here than it does on a
                // table row — it takes a fill as well.
                "gap-2 hover:bg-raised",
                // The row the jump landed on, tinted and ringed — it stays
                // marked after the arrival flash fades, so the reader can look
                // away and still find their place.
                current ? "bg-accent-soft outline outline-1 -outline-offset-2 outline-accent" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                position: "absolute",
                top: rowIndex * rowHeight,
                opacity: row.context === true ? 0.45 : undefined,
                color: KIND_COLORS[row.kind],
              }}
              // Remounted per landing — the `key` is the arrival count — so the
              // animation restarts even when the jump ended on a row that was
              // already on screen and nothing else about it changed.
              background={
                current && marks !== undefined ? (
                  <Box
                    key={marks.arrival}
                    data-arrival={marks.arrival}
                    aria-hidden
                    className="events-jump-arrive pointer-events-none absolute inset-0 rounded-xs"
                  />
                ) : undefined
              }
              leading={
                <>
                  <Figure
                    data-cell="time"
                    role="gridcell"
                    className="relative shrink-0"
                    style={{ width: widthOf(COLUMNS.time) }}
                  >
                    {child && <Connector />}
                    {row.parent ? (
                      // Its offset from the row above, not a stamp of its own:
                      // the child was MOVED here, and an absolute time would make
                      // the column read backwards. The real one is on the hover,
                      // so nothing is actually hidden.
                      <span
                        title={t("ui.logs.events-echo-delta-title", {
                          time: millisecondsToPreciseElapsedFormat(row.timeMs),
                          percent: row.parent.sharePercent.toFixed(1),
                        })}
                      >
                        {t("ui.logs.events-echo-delta", { ms: row.parent.deltaMs })}
                      </span>
                    ) : (
                      millisecondsToPreciseElapsedFormat(row.timeMs)
                    )}
                  </Figure>
                  <CellText name="source" cell={source} width={COLUMNS.source} />
                </>
              }
              /* An effect row carries BOTH: the effect is what it was, the
                 descriptor is whether it landed or ended. Named alone, an apply
                 and its matching remove rendered identically — same effect, same
                 holder, same colour, nothing to tell them apart. Every other
                 kind has one or the other, never both. */
              name={
                <CellText
                  name="ability"
                  cell={action}
                  suffix={row.statusKey === null ? null : detail}
                  connector={child}
                />
              }
              trailing={<CellText name="target" cell={target} width={COLUMNS.target} />}
              columns={
                <Figure
                  data-cell="amount"
                  role="gridcell"
                  className="relative flex shrink-0 items-center justify-end"
                  style={{ width: widthOf(COLUMNS.amount) }}
                >
                  {child && <Connector />}
                  {row.amount === null ? "" : row.amount.toLocaleString()}
                  {share !== null && (
                    <Figure size="sm" tone="dim" className="ml-1">
                      {t("ui.logs.events-echo-share", { percent: share })}
                    </Figure>
                  )}
                </Figure>
              }
            />
          );
        })}
      </Box>
    </>
  );
};

export type EventsTabProps = {
  /** Which log, metric and side to read, and how to narrow and classify what
   * comes back — shared verbatim with the Timeline body (see `StreamContext`),
   * which reads the same stream through the same filters. */
  stream: StreamContext;
  labels: EventLabels;
  /** The party's stored loadouts, which the Amount cell's cap card itemizes a
   * hit's cap-up total against. Empty for a log with no party data. */
  playerData: PlayerData[];
};

/** The metric's raw event stream: the same events its table counts, listed
 * rather than aggregated.
 *
 * Not a view of its own — the side toggle, the metric tabs, the pins and the
 * chart above it are all still live, and this block simply stands where the
 * table would. So it answers to all of them: the metric picks the kinds (see
 * `eventScope`), the side picks the holders where that means anything, and the
 * pins narrow what is left. */
export const EventsTab = ({ stream, labels, playerData }: EventsTabProps) => {
  const { id, metric, hostility, pins, probes } = stream;
  const { t } = useTranslation();
  const { events, total, capUp, suppPairs } = useEvents(id);

  // Keyed by `actorIndex` — the same key `cap_up_by_source` uses and the same
  // one a damage row carries as its `sourceIndex`, so a hit's total and the
  // loadout it is itemized against always describe one player.
  const loadout = useMemo(() => new Map(playerData.map((player) => [player.actorIndex, player])), [playerData]);

  const scope = scopeFor(metric);
  const offered = scopeKinds(scope);

  const [kinds, setKinds] = useState<ReadonlySet<EventKind>>(() => defaultScopeKinds(scope));
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The metric tab changes which kinds exist at all, so a selection made under
  // the old one means nothing under the new. Reset rather than intersected: an
  // intersection can be empty, and an empty strip renders an empty table with
  // every toggle off and no way to tell that from "this fight had none".
  // The column filters go with them, and for the same reason: they name
  // abilities and actors this metric's stream may not carry at all, and a
  // filter you cannot see is a filter you cannot undo.
  useEffect(() => {
    setKinds(defaultScopeKinds(scopeFor(metric)));
    setColumnFilters({});
  }, [metric]);

  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});

  const allRows = useMemo(() => events.map(toEventRow), [events]);
  // What the metric, the side, the kinds and the pins left. The column funnels
  // read their values from THIS — before their own narrowing — so ticking one
  // value does not delete every other box from the menu that ticked it.
  const narrowed = useMemo(
    () => narrowStream(allRows, { scope, hostility, probes, kinds, pins }),
    [allRows, scope, probes, hostility, kinds, pins]
  );
  const shown = useMemo(() => applyColumnFilters(narrowed, columnFilters), [narrowed, columnFilters]);
  // Filters first, THEN nesting: an echo that survived the filter pulls its
  // trigger back in, so nesting has to see what the filter left rather than the
  // other way round. This — not `shown` — is what renders, so it is also what
  // the spacer and the slice are measured from; sized by the shorter list, the
  // re-admitted context rows would have no scroll of their own.
  const nested = useMemo(() => nestSupplementary(shown, allRows, suppPairs), [shown, allRows, suppPairs]);

  const [jumpText, setJumpText] = useState("");
  /** The row the last jump landed on, or null where nothing has been jumped
   * to. */
  const [landed, setLanded] = useState<number | null>(null);
  /** Set by a commit that found nothing, so the control can say so rather than
   * sitting silent as if nothing had been asked. */
  const [missed, setMissed] = useState(false);
  /** How many landings have happened. Nothing reads its value — only that it
   * CHANGED, which is what replays the arrival mark on a jump that ended where
   * the reader was already looking. */
  const [arrival, setArrival] = useState(0);

  // A shorter list can leave the container scrolled past its own end, where it
  // renders nothing at all — so a filter change that shrinks the list has to
  // take the scroll position back with it. The landing goes with it: the row
  // that index named is not the row it names in the new list.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    setLanded(null);
    setMissed(false);
  }, [nested.length]);

  /** Put the view on a row. Drives the scroll BOTH ways — the element, so the
   * container really moves, and the state, so the virtualiser renders what the
   * move brought into view. jsdom fires no scroll event for a programmatic set,
   * and neither does a smooth scroll in time. */
  const land = useCallback(
    (rowIndex: number) => {
      const top = scrollTopFor({
        index: rowIndex,
        rowHeight: ROW_HEIGHT,
        viewportHeight: VIEWPORT_HEIGHT,
        headHeight: HEAD_HEIGHT,
        total: nested.length,
      });
      if (scrollRef.current) scrollRef.current.scrollTop = top;
      setScrollTop(top);
      setArrival((count) => count + 1);
    },
    [nested.length]
  );

  const commit = (text: string) => {
    const ms = parseTimeInput(text);
    const rowIndex = ms === null ? null : rowAtTime(nested, ms);
    setLanded(rowIndex);
    setMissed(rowIndex === null);
    if (rowIndex !== null) land(rowIndex);
  };

  const columnControl = useMemo(
    () => ({
      // Counted against what the OTHER columns left, so the number beside each
      // value tracks the filters already applied — but never against the
      // column's own ticks, which would empty its own menu (see `facetFor`).
      // Only called once a menu opens.
      options: (column: EventColumn): ColumnOption[] =>
        columnOptions(facetFor(narrowed, columnFilters, column), labels, column),
      picked: columnFilters,
      onChange: (column: EventColumn, picked: ReadonlySet<string>) =>
        setColumnFilters((previous) => ({ ...previous, [column]: picked })),
    }),
    [narrowed, labels, columnFilters]
  );

  const slice = visibleSlice({
    scrollTop,
    viewportHeight: VIEWPORT_HEIGHT,
    rowHeight: ROW_HEIGHT,
    total: nested.length,
    overscan: OVERSCAN,
  });

  const toggle = (kind: EventKind) => {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setKinds(next);
  };

  // The cap is the frontend's, not the log's: say so rather than letting a long
  // fight look like it simply ended early.
  const truncated = total > allRows.length;

  return (
    <Box style={{ padding: "4px 16px 14px" }}>
      <EventJumpBar text={jumpText} onTextChange={setJumpText} onCommit={commit} missed={missed} />

      {/* The metric's own sub-filters, the way each Warcraft Logs tab carries
          its own row of them. Only the kinds THIS metric's stream is made of,
          and only when there is more than one — a strip of one offers no choice
          the metric tab above has not already made. */}
      {offered.length > 1 && (
        <Strip rule="top" wrap role="group" aria-label={t("ui.logs.events-kinds-label")}>
          {offered.map((kind) => {
            const on = kinds.has(kind);
            return (
              <Box key={kind} className={[CHIP_CLASS, on ? CHIP_SELECTED_CLASS : ""].join(" ")}>
                <UnstyledButton
                  className={[CHIP_BUTTON_CLASS, on ? CHIP_BUTTON_SELECTED_CLASS : ""].join(" ")}
                  aria-pressed={on}
                  onClick={() => toggle(kind)}
                >
                  <span className={CHIP_SWATCH_CLASS} style={{ backgroundColor: KIND_COLORS[kind] }} aria-hidden />
                  <span>{t(KIND_LABEL_KEY[kind])}</span>
                </UnstyledButton>
              </Box>
            );
          })}
        </Strip>
      )}

      {/* The MATCHES, not the rows drawn: a trigger re-admitted to hold up its
          echo is context the filter did not ask for, and counting it would say
          the filter matched more than it did. It is visibly dimmed, so the two
          numbers cannot be confused for one another. */}
      <Box className="mb-1 flex items-center gap-2">
        <Text size="xs" c="dimmed">
          {truncated
            ? t("ui.logs.events-truncated", { shown: allRows.length, total })
            : t("ui.logs.events-count", { shown: shown.length, total: allRows.length })}
        </Text>
        {/* One way out of every funnel at once. A reader who narrowed three
            columns should not have to remember which three. */}
        {filteredColumns(columnFilters) > 0 && (
          <UnstyledButton
            data-filters-clear-all
            className="rounded-xs px-1 text-xs text-ink-3 hover:bg-raised hover:text-ink"
            onClick={() => setColumnFilters({})}
          >
            {t("ui.logs.events-filters-clear-all")}
          </UnstyledButton>
        )}
      </Box>

      <Box
        ref={scrollRef}
        role="grid"
        aria-label={t("ui.logs.events-table-label")}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{
          height: VIEWPORT_HEIGHT,
          overflowY: "auto",
          position: "relative",
          border: "1px solid var(--color-line)",
          borderRadius: 4,
        }}
      >
        {nested.length === 0 ? (
          <Text size="xs" c="dimmed" p="sm">
            {t("ui.logs.events-empty")}
          </Text>
        ) : (
          <EventRowsTable
            rows={nested.slice(slice.start, slice.end)}
            rowHeight={ROW_HEIGHT}
            startIndex={slice.start}
            totalRows={nested.length}
            labels={labels}
            capUp={capUp}
            loadout={loadout}
            marks={{ current: landed, arrival }}
            filters={columnControl}
          />
        )}
      </Box>
    </Box>
  );
};
