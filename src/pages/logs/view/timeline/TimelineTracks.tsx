import { Box, Text, Tooltip } from "@mantine/core";
import type React from "react";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { humanizeNumber, millisecondsToPreciseElapsedFormat } from "@/utils";

import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import { AnalysisRow } from "../analysis/AnalysisRow";
import { HoverCard, type CardAmount, type CardSection } from "../analysis/HoverCard";

import { TimelineRuler } from "./TimelineRuler";
import type { Lane, LaneMark } from "./laneMarks";
import { laneRows } from "./laneRows";
import { markCardSections } from "./markCard";

/** How far apart ruler ticks are. Five seconds against a 30s viewport gives
 * six labelled ticks — dense enough to read a moment off, sparse enough that
 * the labels do not collide. */
const TICK_STEP_MS = 5000;

/** Above this many hits a cast draws solid.
 *
 * Bounds the DOM as much as the eye: a busy lane in a six-minute fight would
 * otherwise mount thousands of tick nodes, and ticks that close read as noise
 * rather than as rhythm. */
const MAX_CAST_TICKS = 40;

/** A percentage, at the precision a sub-pixel position needs and no more —
 * `toFixed` keeps the DOM stable across renders where a raw float would not. */
const percent = (value: number, of: number): string => (of === 0 ? "0%" : `${((value / of) * 100).toFixed(4)}%`);

export type TimelineTracksProps = {
  lanes: Lane[];
  /** The window's length in milliseconds — what 100% of a track is. */
  domainMs: number;
  /** The window's start in absolute fight time, for the ruler's labels. */
  startMs: number;
  /** Milliseconds shown per viewport width. The content is widened by
   * `domainMs / viewportMs`, which fixes the scale without measuring. */
  viewportMs: number;
  /** The caller's namer — the SAME one the table uses, so a lane and its row
   * cannot be named or pictured two different ways. It already returns the
   * icon alongside the name (see `AnalysisView`'s `renderLabel`). */
  renderLabel: (row: MetricRow) => React.ReactNode;
  rowColor: (row: MetricRow) => string;
  onPin: (pins: Partial<SelectorPins>) => void;
  /** A section name per row, for rows that group into titled runs — the same
   * prop, and the same rows-already-sorted contract, as `MetricTable`. */
  sectionLabel?: (row: MetricRow) => string | null;
  /** The hover card's sections for one lane's row — the SAME accessor the
   * table uses, so a lane and its row explain themselves identically. */
  rowSections?: (row: MetricRow) => CardSection[] | null;
  /** What those sections measure. Without it no card is drawn at all, which is
   * the same rule `MetricTable` follows. */
  cardAmount?: CardAmount;
  /** Names and art for one mark contribution, for the mark's own card. */
  markEntry?: (key: string) => { name: string; iconUrl?: string };
  emptyKey?: string;
};

/** The rows of the current metric, drawn against fight time.
 *
 * Not a view of its own: the selector bar, the metric tabs, the side toggle and
 * the chart above it are all still live, and this block simply stands where the
 * table would — the same contract `EventsTab` has.
 *
 * Two columns inside ONE vertical scroller: the lane names, fixed, and the
 * tracks, which own the only horizontal scrollbar. Both columns map the single
 * `laneRows` sequence, so neither can invent a row the other does not have.
 *
 * They stay in step only while their row heights match EXACTLY, so each pair
 * reads the SAME token rather than restating a number:
 *
 *   ruler    `h-head`  TimelineRuler   ↔  the names column's opening gap
 *   heading  `h-head`  the heading     ↔  the tracks column's gap row
 *   lane     `h-row`   `AnalysisRow`   ↔  the lane row
 *
 * A lane IS an `AnalysisRow`, and the track beside it has to be exactly as
 * tall. Stated twice, the two columns drift apart the first time one is
 * nudged. */
export const TimelineTracks = ({
  lanes,
  domainMs,
  startMs,
  viewportMs,
  renderLabel,
  rowColor,
  onPin,
  sectionLabel,
  rowSections,
  cardAmount,
  markEntry,
  emptyKey = "ui.logs.timeline-empty",
}: TimelineTracksProps) => {
  const { t } = useTranslation();

  // Derived once and rendered twice — see `laneRows`. Two columns each applying
  // the heading rule for themselves is how they would come to differ by a row.
  const rows = useMemo(() => laneRows(lanes, sectionLabel), [lanes, sectionLabel]);

  // Built once per lane set rather than once per render, the same reason
  // `MetricTable` memoises its own: one call folds a whole skill breakdown,
  // and the card that consumes it only ever opens under the pointer. The
  // timeline multiplies that by mark count, so recomputing on every render was
  // the most expensive thing this body did.
  const sectionsByLane = useMemo(
    () => (rowSections ? new Map(lanes.map((lane) => [lane.row.key, rowSections(lane.row)])) : null),
    [lanes, rowSections]
  );

  const sectionsByMark = useMemo(() => {
    if (!cardAmount || !markEntry) return null;
    const byMark = new Map<string, CardSection[]>();
    for (const lane of lanes) {
      const color = rowColor(lane.row);
      for (const mark of lane.marks) {
        byMark.set(
          `${lane.row.key}:${mark.startMs}:${mark.endMs}`,
          markCardSections(mark, { color, entry: markEntry })
        );
      }
    }
    return byMark;
  }, [lanes, rowColor, cardAmount, markEntry]);

  // AFTER the memos: an early return above them would make this component call
  // a different number of hooks on an empty lane set than on a full one, which
  // React rejects the moment a filter empties the timeline and then refills it.
  if (lanes.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="lg">
        {t(emptyKey)}
      </Text>
    );
  }

  // What a mark says when you hover it, where it has no contributions to
  // decompose into a card. A real span reports how long it was up; a fold
  // reports how many hits are inside it and what they came to — the count is
  // the whole reason a fold is honest.
  const markTooltip = (lane: Lane, mark: LaneMark): string => {
    if (lane.spans) {
      return [
        t("ui.logs.timeline-mark-span", {
          start: millisecondsToPreciseElapsedFormat(startMs + mark.startMs),
          end: millisecondsToPreciseElapsedFormat(startMs + mark.endMs),
        }),
        t("ui.logs.timeline-mark-uptime", { seconds: Math.round((mark.endMs - mark.startMs) / 1000) }),
      ].join(" · ");
    }
    const when =
      mark.startMs === mark.endMs
        ? t("ui.logs.timeline-mark-at", { time: millisecondsToPreciseElapsedFormat(startMs + mark.startMs) })
        : t("ui.logs.timeline-mark-span", {
            start: millisecondsToPreciseElapsedFormat(startMs + mark.startMs),
            end: millisecondsToPreciseElapsedFormat(startMs + mark.endMs),
          });
    // A mark the DENSITY fold merged holds several casts, and calling that "N
    // hits" would describe the wrong grouping — the bar the user is pointing at
    // is several casts, not one long one.
    const parts = [
      mark.casts > 1
        ? t("ui.logs.timeline-mark-casts", { count: mark.casts })
        : t("ui.logs.timeline-mark-hits", { count: mark.count }),
      when,
    ];
    if (mark.amount !== null) parts.push(t("ui.logs.timeline-mark-amount", { amount: humanizeNumber(mark.amount) }));
    return parts.join(" · ");
  };

  // A lane's name cell IS the table's row, so it carries the table's height and
  // the table's art — the 22px icon `renderLabel` emits used to be squeezed to
  // nothing by a 22px lane.
  const laneName = (lane: Lane) => {
    const pinOnClick = lane.row.pinOnClick;
    const rowNode = (
      <AnalysisRow name={renderLabel(lane.row)} onClick={pinOnClick ? () => onPin(pinOnClick) : undefined} />
    );
    const sections = sectionsByLane?.get(lane.row.key) ?? null;
    // No second emptiness guard: `HoverCard` already renders the child alone
    // when every section is empty.
    return sections && cardAmount ? (
      <HoverCard sections={sections} {...cardAmount}>
        {rowNode}
      </HoverCard>
    ) : (
      rowNode
    );
  };

  // A mark WITH contributions opens the table's own card; a mark without — a
  // status row's real span — keeps the concise tooltip, which is the only thing
  // that can report a duration.
  const laneMarks = (lane: Lane) => {
    const color = rowColor(lane.row);
    return lane.marks.map((mark) => {
      const key = `${mark.startMs}:${mark.endMs}`;
      const sections = sectionsByMark?.get(`${lane.row.key}:${key}`) ?? [];
      // A cast is a fold that MEANS something — several hits of one skill — so
      // it draws as a bar with its hits ticked inside. A lone instant and a
      // status row's real span both stay as they were.
      const isCast = !lane.spans && mark.count > 1;
      const spanMs = mark.endMs - mark.startMs;
      const markNode = (
        <Box
          data-mark
          data-mark-kind={lane.spans ? "span" : isCast ? "cast" : "instant"}
          className={[
            "absolute inset-y-1 min-w-0.5 rounded-[1px]",
            // ONE opacity per mark rather than a base and two modifiers: a real
            // span reads as a filled bar, a folded instant as a tick, and a cast
            // a touch softer so its bar reads as a CONTAINER for the ticks
            // inside it. Layered as separate utilities the strongest would win
            // on stylesheet order, not on which applies.
            lane.spans ? "opacity-85" : isCast ? "opacity-90" : "opacity-100",
          ].join(" ")}
          style={{
            left: percent(mark.startMs, domainMs),
            width: percent(spanMs, domainMs),
            backgroundColor: color,
          }}
        >
          {isCast &&
            mark.count <= MAX_CAST_TICKS &&
            spanMs > 0 &&
            mark.hits.map((hit, index) => (
              <Box
                key={index}
                data-testid="timeline-tick"
                data-echo={hit.echo || undefined}
                // Echo hits match the fainter segment MetricBar draws in the table.
                className={[
                  "pointer-events-none absolute inset-y-0 w-px bg-white",
                  hit.echo ? "opacity-25" : "opacity-55",
                ].join(" ")}
                style={{ left: percent(hit.atMs - mark.startMs, spanMs) }}
              />
            ))}
        </Box>
      );
      return sections.length > 0 && cardAmount ? (
        <HoverCard key={key} sections={sections} {...cardAmount}>
          {markNode}
        </HoverCard>
      ) : (
        <Tooltip key={key} label={markTooltip(lane, mark)} withinPortal openDelay={80}>
          {markNode}
        </Tooltip>
      );
    });
  };

  return (
    <Box style={{ padding: "4px 16px 14px" }}>
      {/* The vertical scroller. Both columns live in it, so they scroll down
          together; only the right one scrolls sideways. */}
      <Box
        className="flex max-h-[calc(460px*var(--density))] overflow-y-auto rounded-sm border border-line"
        role="group"
        aria-label={t("ui.logs.timeline-label")}
      >
        {/* Outside the horizontal scroller, so the names cannot pan away and no
            longer need to be sticky. Opaque, and separated by its own border. */}
        <Box
          data-lane-names
          className="min-w-0 flex-none basis-name border-r border-line bg-[var(--mantine-color-body)]"
          role="grid"
          aria-label={t("ui.logs.timeline-lanes-label")}
        >
          {/* Stands in for the ruler, so lane one is level in both columns, and
              carries the ruler's underline across the names column. */}
          <Box className="h-head border-b border-line" aria-hidden />
          {rows.map((row) =>
            row.kind === "heading" ? (
              // Fixed at the gap row's own height in the other column — a
              // heading that grew with its text would push the names out of
              // step with their marks.
              <Box
                key={row.key}
                data-lane-heading
                className="flex h-head items-end overflow-hidden whitespace-nowrap px-2 pb-[3px] text-label uppercase tracking-[0.04em] text-[var(--mantine-color-dimmed)]"
              >
                {row.label}
              </Box>
            ) : (
              <Fragment key={row.key}>{laneName(row.lane)}</Fragment>
            )
          )}
        </Box>

        {/* The ONLY horizontal scrollbar. `min-w-0` so the flex item may shrink
            below its (very wide) content instead of stretching the frame. */}
        <Box data-tracks-scroll className="min-w-0 flex-1 overflow-x-auto">
          {/* Widened by exactly domain/viewport, so percentages inside address
              the whole window and the scale needs no measurement. */}
          <Box
            data-timeline-content
            className="relative min-w-full"
            style={{ width: `${(domainMs / viewportMs) * 100}%` }}
          >
            <TimelineRuler domainMs={domainMs} startMs={startMs} stepMs={TICK_STEP_MS} />

            {rows.map((row) =>
              row.kind === "heading" ? (
                // The heading's height with none of its text: the names column
                // carries the words, this column only has to stay level.
                <Box key={row.key} data-lane-gap className="h-head" aria-hidden />
              ) : (
                <Box key={row.key} data-lane-row className="flex h-row items-stretch hover:bg-white/5">
                  {/* Faintly filled, so an empty lane reads as "nothing here"
                      rather than as a missing cell. */}
                  <Box className="relative min-w-0 flex-1 before:absolute before:inset-x-0 before:inset-y-1 before:bg-line before:opacity-25 before:content-['']">
                    {laneMarks(row.lane)}
                  </Box>
                </Box>
              )
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
