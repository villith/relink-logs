import { Box, Text, Tooltip, UnstyledButton } from "@mantine/core";
import type React from "react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { humanizeNumber, millisecondsToPreciseElapsedFormat } from "@/utils";

import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import "../analysis/analysis.css";

import { TimelineRuler } from "./TimelineRuler";
import type { Lane, LaneMark } from "./laneMarks";

/** How far apart ruler ticks are. Five seconds against a 30s viewport gives
 * six labelled ticks — dense enough to read a moment off, sparse enough that
 * the labels do not collide. */
const TICK_STEP_MS = 5000;

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
  emptyKey?: string;
};

/** The rows of the current metric, drawn against fight time.
 *
 * Not a view of its own: the selector bar, the metric tabs, the side toggle and
 * the chart above it are all still live, and this block simply stands where the
 * table would — the same contract `EventsTab` has. */
export const TimelineTracks = ({
  lanes,
  domainMs,
  startMs,
  viewportMs,
  renderLabel,
  rowColor,
  onPin,
  sectionLabel,
  emptyKey = "ui.logs.timeline-empty",
}: TimelineTracksProps) => {
  const { t } = useTranslation();

  if (lanes.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="lg">
        {t(emptyKey)}
      </Text>
    );
  }

  // What a mark says when you hover it. A real span reports how long it was up;
  // a fold reports how many hits are inside it and what they came to — the
  // count is the whole reason a fold is honest.
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
    const parts = [t("ui.logs.timeline-mark-hits", { count: mark.count }), when];
    if (mark.amount !== null) parts.push(t("ui.logs.timeline-mark-amount", { amount: humanizeNumber(mark.amount) }));
    return parts.join(" · ");
  };

  return (
    <Box style={{ padding: "4px 16px 14px" }}>
      <Box className="timeline-scroll" aria-label={t("ui.logs.timeline-label")}>
        {/* Widened by exactly domain/viewport, so percentages inside address
            the whole window and the scale needs no measurement. */}
        <Box className="timeline-content" style={{ width: `${(domainMs / viewportMs) * 100}%` }}>
          <TimelineRuler domainMs={domainMs} startMs={startMs} stepMs={TICK_STEP_MS} />

          <Box role="list" aria-label={t("ui.logs.timeline-lanes-label")}>
            {lanes.map((lane, laneIndex) => {
              // A subheader is drawn only where the section CHANGES, so a run
              // of lanes in one section carries a single heading. Compared
              // against the PREVIOUS LANE rather than a variable carried
              // through the map — the same stateless shape `MetricTable` uses
              // for its own runs (see its `previousSection`).
              const section = sectionLabel?.(lane.row) ?? null;
              const previousSection = laneIndex === 0 ? null : sectionLabel?.(lanes[laneIndex - 1].row) ?? null;
              const color = rowColor(lane.row);

              return (
                <Fragment key={lane.row.key}>
                  {section !== null && section !== previousSection && <Box className="timeline-section">{section}</Box>}
                  <Box className="timeline-lane" role="listitem">
                    {/* A button, not a div: pinning is the same action the
                        table row answers to, and it must be reachable by
                        keyboard here too. */}
                    <UnstyledButton
                      className="timeline-lane-name"
                      onClick={() => lane.row.pinOnClick && onPin(lane.row.pinOnClick)}
                      disabled={lane.row.pinOnClick === null}
                    >
                      {renderLabel(lane.row)}
                    </UnstyledButton>
                    <Box className="timeline-lane-track">
                      {lane.marks.map((mark) => (
                        <Tooltip
                          key={`${mark.startMs}:${mark.endMs}`}
                          label={markTooltip(lane, mark)}
                          withinPortal
                          openDelay={80}
                        >
                          <Box
                            className={`timeline-mark ${lane.spans ? "timeline-mark-span" : "timeline-mark-instant"}`}
                            style={{
                              left: percent(mark.startMs, domainMs),
                              width: percent(mark.endMs - mark.startMs, domainMs),
                              backgroundColor: color,
                            }}
                          />
                        </Tooltip>
                      ))}
                    </Box>
                  </Box>
                </Fragment>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
