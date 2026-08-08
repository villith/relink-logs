import { Box, Text, Tooltip } from "@mantine/core";
import type React from "react";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { humanizeNumber, millisecondsToPreciseElapsedFormat } from "@/utils";

import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import { AnalysisRow } from "../analysis/AnalysisRow";
import { HoverCard, type CardAmount, type CardSection } from "../analysis/HoverCard";
import "../analysis/analysis.css";

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
 * `laneRows` sequence, so neither can invent a row the other does not have; the
 * heights that keep them level are in `analysis.css`. */
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
          className={`timeline-mark ${lane.spans ? "timeline-mark-span" : "timeline-mark-instant"}${
            isCast ? " timeline-mark-cast" : ""
          }`}
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
                className={`timeline-tick${hit.echo ? " timeline-tick-echo" : ""}`}
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
      <Box className="timeline-frame" role="group" aria-label={t("ui.logs.timeline-label")}>
        <Box className="timeline-names" role="grid" aria-label={t("ui.logs.timeline-lanes-label")}>
          {/* Stands in for the ruler, so lane one is level in both columns. */}
          <Box className="timeline-ruler-gap" aria-hidden />
          {rows.map((row) =>
            row.kind === "heading" ? (
              <Box key={row.key} className="timeline-section">
                {row.label}
              </Box>
            ) : (
              <Fragment key={row.key}>{laneName(row.lane)}</Fragment>
            )
          )}
        </Box>

        <Box className="timeline-tracks-scroll">
          {/* Widened by exactly domain/viewport, so percentages inside address
              the whole window and the scale needs no measurement. */}
          <Box className="timeline-content" style={{ width: `${(domainMs / viewportMs) * 100}%` }}>
            <TimelineRuler domainMs={domainMs} startMs={startMs} stepMs={TICK_STEP_MS} />

            {rows.map((row) =>
              row.kind === "heading" ? (
                // The heading's height with none of its text: the names column
                // carries the words, this column only has to stay level.
                <Box key={row.key} className="timeline-row-gap" aria-hidden />
              ) : (
                <Box key={row.key} className="timeline-row">
                  <Box className="timeline-lane-track">{laneMarks(row.lane)}</Box>
                </Box>
              )
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
