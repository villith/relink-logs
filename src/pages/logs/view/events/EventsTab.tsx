import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EntityIcon } from "@/components/ui/EntityIcon";
import { Strip } from "@/components/ui/Strip";
import { millisecondsToPreciseElapsedFormat } from "@/utils";

import "../analysis/analysis.css";

import {
  CHIP_BUTTON_CLASS,
  CHIP_BUTTON_SELECTED_CLASS,
  CHIP_CLASS,
  CHIP_SELECTED_CLASS,
  CHIP_SWATCH_CLASS,
} from "../analysis/chipAnatomy";
import type { StreamContext } from "../analysis/model/bodyContext";
import { toEventRow, type ActorSpace, type EventKind } from "./eventRows";
import { defaultScopeKinds, narrowStream, scopeFor, scopeKinds } from "./eventScope";
import { nestSupplementary, type NestedEventRow } from "./nestSupplementary";
import { useEvents } from "./useEvents";
import { visibleSlice } from "./windowSlice";

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

/** Row height in px. Fixed, which is what makes `visibleSlice` pure arithmetic
 * — so it is a NUMBER here and not `--spacing-row`, which the virtualiser could
 * not do division with. Kept a step under a table row, as it always was, but
 * moved with the rest of the view's scale: the stream's art is now
 * `--spacing-icon-xs`, which at 22px left no air above or below it. */
const ROW_HEIGHT = 26;
/** Rows rendered beyond each edge of the viewport, so a fast scroll does not
 * outrun the render. */
const OVERSCAN = 10;
/** The scroll container's height in px. A constant rather than a measurement:
 * the height is ours to choose, and choosing it means `visibleSlice` needs no
 * ref-measuring dance and no resize observer. */
const VIEWPORT_HEIGHT = 460;

/** The five column widths, shared by the header and the rows so the two cannot
 * drift apart. The ability column takes the slack.
 *
 * Target is the widest of the named columns: a spawn is named "<Enemy> #2" off
 * the full translated enemy name, which is routinely longer than a player's
 * label — "Vulkan Bolla Nihilla #2" against "Narmaya".
 *
 * Amount is wider than the digits need because a nested echo prints its share
 * of its trigger beside them. Widened for EVERY row rather than only the ones
 * that carry a share: the cells are flex items, so a cell that grew to fit its
 * own content would drag the target and ability columns left on that row alone,
 * and columns that move per row are not columns. */
const COLUMNS = { time: 74, source: 160, target: 230, amount: 118 };

/** How far a nested child's time is indented, in px. Inside the column's own
 * width, so the column does not change size and the numbers below it stay put. */
const CHILD_INDENT = 10;

/** One named-and-pictured cell. The art is 16px rather than the analysis
 * table's 22: these rows are 22px tall, so the table's own size would leave no
 * air at all. `alt=""` because the name is right beside it — a screen reader
 * reading both would say every actor twice.
 *
 * `title` because these columns are narrow and a name past them ellipsises;
 * hovering is then the only way left to read the rest of it. */
const CellText = ({
  cell,
  name,
  width,
  flex,
  suffix,
  connector,
}: {
  cell: EventCell;
  /** The column, as `data-cell` — what the tests address a cell by. */
  name: string;
  width?: number;
  flex?: boolean;
  /** A dimmed qualifier after the name, for a cell whose name alone does not
   * say the whole thing (an effect landing vs the same effect ending). */
  suffix?: string | null;
  /** Draw the elbow that says this row hangs from the one above it. */
  connector?: boolean;
}) => (
  <Group
    gap={5}
    wrap="nowrap"
    w={width}
    data-cell={name}
    style={flex ? { flex: 1, minWidth: 0 } : { minWidth: 0, flexShrink: 0 }}
  >
    {connector && (
      // eslint-disable-next-line i18next/no-literal-string -- tree connector glyph, not prose
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        └─
      </Text>
    )}
    {/* Smaller than the table's: the events rows are shorter, and the table's
        own icon would fill one edge to edge. */}
    {cell.iconUrl !== undefined && <EntityIcon size="card" src={cell.iconUrl} alt="" />}
    {/* Only a cell that HAS a colour takes one — an actor. Everything else
        (the time, the ability, the amount) inherits the row's kind colour,
        which is what still says at a glance what sort of event this is. */}
    <Text size="xs" truncate title={cell.name} style={cell.color === undefined ? undefined : { color: cell.color }}>
      {cell.name}
    </Text>
    {suffix !== undefined && suffix !== null && suffix !== "" && (
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {suffix}
      </Text>
    )}
  </Group>
);

export const EventRowsTable = ({
  rows,
  rowHeight,
  startIndex,
  totalRows,
  labels,
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
}) => {
  const { t } = useTranslation();

  return (
    <>
      {/* Sticky, and a sibling of the row container rather than inside it: the
          rows are absolutely positioned against that container's own origin, so
          a header within it would sit under row 0. */}
      <Box
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: "var(--mantine-color-body)",
          borderBottom: "1px solid var(--color-line)",
        }}
      >
        <Group gap="xs" px="xs" wrap="nowrap" style={{ height: rowHeight }}>
          <Text size="xs" c="dimmed" w={COLUMNS.time}>
            {t("ui.logs.events-time")}
          </Text>
          <Text size="xs" c="dimmed" w={COLUMNS.source}>
            {t("ui.logs.events-source")}
          </Text>
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {t("ui.logs.events-ability")}
          </Text>
          <Text size="xs" c="dimmed" w={COLUMNS.target}>
            {t("ui.logs.events-target")}
          </Text>
          <Text size="xs" c="dimmed" w={COLUMNS.amount} ta="right">
            {t("ui.logs.events-amount")}
          </Text>
        </Group>
      </Box>

      <Box data-event-body style={{ position: "relative", height: totalRows * rowHeight }}>
        {rows.map((row, offset) => {
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
          return (
            <Box
              key={`${row.timeMs}:${startIndex + offset}`}
              data-event-row
              // A trigger pulled back past a filter is context, not a match:
              // dimmed, and it says so on hover rather than looking like a
              // filter that failed to apply.
              title={row.context ? t("ui.logs.events-echo-context-title") : undefined}
              style={{
                position: "absolute",
                top: (startIndex + offset) * rowHeight,
                height: rowHeight,
                width: "100%",
                opacity: row.context ? 0.45 : undefined,
              }}
            >
              <Group gap="xs" px="xs" wrap="nowrap" style={{ color: KIND_COLORS[row.kind], height: rowHeight }}>
                <Text
                  size="xs"
                  w={COLUMNS.time}
                  data-cell="time"
                  // Padded INSIDE the column, so the indent that marks a child
                  // does not push the column itself out of line.
                  style={{ fontVariantNumeric: "tabular-nums", paddingLeft: row.parent ? CHILD_INDENT : undefined }}
                >
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
                </Text>
                <CellText name="source" cell={source} width={COLUMNS.source} />
                {/* An effect row carries BOTH: the effect is what it was, the
                    descriptor is whether it landed or ended. Named alone, an
                    apply and its matching remove rendered identically — same
                    effect, same holder, same colour, nothing to tell them
                    apart. Every other kind has one or the other, never both. */}
                <CellText
                  name="ability"
                  flex
                  cell={action}
                  suffix={row.statusKey === null ? null : detail}
                  connector={row.parent !== undefined}
                />
                <CellText name="target" cell={target} width={COLUMNS.target} />
                <Text
                  size="xs"
                  w={COLUMNS.amount}
                  ta="right"
                  data-cell="amount"
                  style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
                >
                  {row.amount === null ? "" : row.amount.toLocaleString()}
                  {share !== null && (
                    <Text span size="xs" c="dimmed" ml={4}>
                      {t("ui.logs.events-echo-share", { percent: share })}
                    </Text>
                  )}
                </Text>
              </Group>
            </Box>
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
};

/** The metric's raw event stream: the same events its table counts, listed
 * rather than aggregated.
 *
 * Not a view of its own — the side toggle, the metric tabs, the pins and the
 * chart above it are all still live, and this block simply stands where the
 * table would. So it answers to all of them: the metric picks the kinds (see
 * `eventScope`), the side picks the holders where that means anything, and the
 * pins narrow what is left. */
export const EventsTab = ({ stream, labels }: EventsTabProps) => {
  const { id, metric, hostility, pins, probes } = stream;
  const { t } = useTranslation();
  const { events, total, suppPairs } = useEvents(id);

  const scope = scopeFor(metric);
  const offered = scopeKinds(scope);

  const [kinds, setKinds] = useState<ReadonlySet<EventKind>>(() => defaultScopeKinds(scope));
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The metric tab changes which kinds exist at all, so a selection made under
  // the old one means nothing under the new. Reset rather than intersected: an
  // intersection can be empty, and an empty strip renders an empty table with
  // every toggle off and no way to tell that from "this fight had none".
  useEffect(() => setKinds(defaultScopeKinds(scopeFor(metric))), [metric]);

  const allRows = useMemo(() => events.map(toEventRow), [events]);
  const shown = useMemo(
    () => narrowStream(allRows, { scope, hostility, probes, kinds, pins }),
    [allRows, scope, probes, hostility, kinds, pins]
  );
  // Filters first, THEN nesting: an echo that survived the filter pulls its
  // trigger back in, so nesting has to see what the filter left rather than the
  // other way round. This — not `shown` — is what renders, so it is also what
  // the spacer and the slice are measured from; sized by the shorter list, the
  // re-admitted context rows would have no scroll of their own.
  const nested = useMemo(() => nestSupplementary(shown, allRows, suppPairs), [shown, allRows, suppPairs]);

  // A shorter list can leave the container scrolled past its own end, where it
  // renders nothing at all — so a filter change that shrinks the list has to
  // take the scroll position back with it.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [nested.length]);

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
      <Text size="xs" c="dimmed" mb={4}>
        {truncated
          ? t("ui.logs.events-truncated", { shown: allRows.length, total })
          : t("ui.logs.events-count", { shown: shown.length, total: allRows.length })}
      </Text>

      <Box
        ref={scrollRef}
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
          />
        )}
      </Box>
    </Box>
  );
};
