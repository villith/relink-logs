import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { millisecondsToPreciseElapsedFormat } from "@/utils";

import "../analysis/analysis.css";

import {
  DEFAULT_KINDS,
  EVENT_KINDS,
  filterByKind,
  filterByPins,
  toEventRow,
  type EventKind,
  type EventPins,
  type EventRow,
} from "./eventRows";
import { useEvents } from "./useEvents";
import { visibleSlice } from "./windowSlice";

/** How a row's indexes become names. Supplied by the view, which already owns
 * these resolvers for its own table — a second spelling here would let the two
 * name one actor two ways. */
export type EventLabels = {
  source: (index: number) => string;
  /** A target is named from its actor index AND the moment it was hit: the game
   * reissues a dead boss's actor index to a later spawn, so the index alone
   * cannot say which of them a row belongs to. */
  target: (actorIndex: number, atMs: number) => string;
  ability: (key: string) => string;
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

/** Row height in px. Fixed, which is what makes `visibleSlice` pure arithmetic. */
const ROW_HEIGHT = 22;
/** Rows rendered beyond each edge of the viewport, so a fast scroll does not
 * outrun the render. */
const OVERSCAN = 10;
/** The scroll container's height in px. A constant rather than a measurement:
 * the height is ours to choose, and choosing it means `visibleSlice` needs no
 * ref-measuring dance and no resize observer. */
const VIEWPORT_HEIGHT = 460;

/** The five column widths, shared by the header and the rows so the two cannot
 * drift apart. The ability column takes the slack. */
const COLUMNS = { time: 74, source: 130, target: 130, amount: 78 };

export const EventRowsTable = ({
  rows,
  rowHeight,
  startIndex,
  totalRows,
  labels,
}: {
  /** The visible slice only. */
  rows: EventRow[];
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
          borderBottom: "1px solid var(--an-line)",
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
        {rows.map((row, offset) => (
          <Box
            key={`${row.timeMs}:${startIndex + offset}`}
            data-event-row
            style={{
              position: "absolute",
              top: (startIndex + offset) * rowHeight,
              height: rowHeight,
              width: "100%",
            }}
          >
            <Group gap="xs" px="xs" wrap="nowrap" style={{ color: KIND_COLORS[row.kind], height: rowHeight }}>
              <Text size="xs" w={COLUMNS.time} style={{ fontVariantNumeric: "tabular-nums" }}>
                {millisecondsToPreciseElapsedFormat(row.timeMs)}
              </Text>
              <Text size="xs" w={COLUMNS.source} truncate>
                {row.sourceIndex === null ? "" : labels.source(row.sourceIndex)}
              </Text>
              <Text size="xs" style={{ flex: 1 }} truncate>
                {row.abilityKey !== null
                  ? labels.ability(row.abilityKey)
                  : row.detailKey === null
                    ? ""
                    : t(row.detailKey, row.detailParams)}
              </Text>
              <Text size="xs" w={COLUMNS.target} truncate data-target-cell>
                {row.targetIndex === null ? "" : labels.target(row.targetIndex, row.timeMs)}
              </Text>
              <Text
                size="xs"
                w={COLUMNS.amount}
                ta="right"
                data-amount-cell
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {row.amount === null ? "" : row.amount.toLocaleString()}
              </Text>
            </Group>
          </Box>
        ))}
      </Box>
    </>
  );
};

export type EventsTabProps = {
  id: string | undefined;
  pins: EventPins;
  labels: EventLabels;
};

/** The raw event stream, filtered by kind and by the view's pins, windowed over
 * a fixed row height. */
export const EventsTab = ({ id, pins, labels }: EventsTabProps) => {
  const { t } = useTranslation();
  const { events, total } = useEvents(id);

  const [kinds, setKinds] = useState<ReadonlySet<EventKind>>(DEFAULT_KINDS);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const allRows = useMemo(() => events.map(toEventRow), [events]);
  const shown = useMemo(() => filterByPins(filterByKind(allRows, kinds), pins), [allRows, kinds, pins]);

  // A shorter list can leave the container scrolled past its own end, where it
  // renders nothing at all — so a filter change that shrinks the list has to
  // take the scroll position back with it.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [shown.length]);

  const slice = visibleSlice({
    scrollTop,
    viewportHeight: VIEWPORT_HEIGHT,
    rowHeight: ROW_HEIGHT,
    total: shown.length,
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
      <Box className="analysis-aura-strip" role="group" aria-label={t("ui.logs.events-kinds-label")}>
        {EVENT_KINDS.map((kind) => {
          const on = kinds.has(kind);
          return (
            <Box key={kind} className={`analysis-aura-chip${on ? " analysis-aura-chip-selected" : ""}`}>
              <UnstyledButton className="analysis-aura-chip-button" aria-pressed={on} onClick={() => toggle(kind)}>
                <span
                  className="analysis-window-chip-swatch"
                  style={{ backgroundColor: KIND_COLORS[kind] }}
                  aria-hidden
                />
                <span className="analysis-aura-chip-name">{t(KIND_LABEL_KEY[kind])}</span>
              </UnstyledButton>
            </Box>
          );
        })}
      </Box>

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
          border: "1px solid var(--an-line)",
          borderRadius: 4,
        }}
      >
        {shown.length === 0 ? (
          <Text size="xs" c="dimmed" p="sm">
            {t("ui.logs.events-empty")}
          </Text>
        ) : (
          <EventRowsTable
            rows={shown.slice(slice.start, slice.end)}
            rowHeight={ROW_HEIGHT}
            startIndex={slice.start}
            totalRows={shown.length}
            labels={labels}
          />
        )}
      </Box>
    </Box>
  );
};
