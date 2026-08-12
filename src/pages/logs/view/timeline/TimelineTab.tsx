import { Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { EnemyType, SkillRow } from "@/types";

import type { RowKeying } from "../abilitySkills";
import type { RowPresentation, StreamContext } from "../analysis/model/bodyContext";
import type { ActorSpace } from "../events/eventRows";
import { toEventRow } from "../events/eventRows";
import { defaultScopeKinds, narrowStream, scopeFor, type EventScope } from "../events/eventScope";
import { useEvents } from "../events/useEvents";
import type { Span } from "../spans";

import { TimelineTracks } from "./TimelineTracks";
import { MARK_GAP_PX, lanesFor, markGapMs, marksByLane } from "./laneMarks";
import { laneMatcherFor } from "./laneMatch";
import { laneShapeOf } from "./laneShape";

/** How much time one viewport width shows — Warcraft Logs' own scale, fifteen
 * seconds of a six-minute fight. Thirty fitted a whole rotation on screen but
 * pressed a cast's hits into a few pixels; at this zoom the individual hits
 * inside a cast are far enough apart to be read as rhythm, and the fight is
 * panned rather than taken in at a glance. It also halves `markGapMs`, so two
 * marks a screen-pixel apart now survive as two. */
export const TIMELINE_VIEWPORT_MS = 15_000;

/** Which end of a damage event a metric's lanes are keyed by — read off the
 * scope's own `direction` rather than re-tested against the metric name, so a
 * lane keys by the end `filterByScope` already selected the hits from. */
const laneEndFor = (scope: EventScope): "source" | "target" => (scope.direction === "taken" ? "target" : "source");

export type TimelineTabProps = {
  /** Which log, metric and side to read the event stream for, and how to narrow
   * it — shared verbatim with the Events body (see `StreamContext`). */
  stream: StreamContext;
  /** The rows to draw and everything drawn about them — shared verbatim with
   * the table body (see `RowPresentation`), which is what stops a lane and its
   * table row being named, coloured or explained two different ways. */
  presentation: RowPresentation;
  /** The view's `everySkill`, for expanding a folded ability row. */
  everySkill: SkillRow[];
  /** The view's row keying — passed rather than rebuilt, so a lane and the
   * table row above it cannot disagree about which row an echo is on. It also
   * carries the collapse flag the cast fold clusters echoes by. */
  keying?: RowKeying;
  /** The committed window, in absolute fight milliseconds. */
  window: Span;
  segmentAt: (index: number, atMs: number, space: ActorSpace) => number;
  enemyTypeAt: (index: number, atMs: number) => EnemyType | null;
  /** Names and art for one mark's contribution. A mark's parts are keyed by
   * whatever the event named — an action for a hit, a `status:` key for an
   * effect — so it dispatches on the same `status:` prefix the selector's art
   * already uses. A single resolver would name an effect through the ability
   * join and print whatever that join's fallback picked. */
  markEntry?: (key: string) => { name: string; iconUrl?: string };
};

/** The metric's rows drawn against fight time.
 *
 * The stream it reads and the filters it applies are the Events tab's, and the
 * rows it draws are the table's. It adds a join between them and nothing else
 * — which is what keeps three bodies answering for one fight. */
export const TimelineTab = ({
  stream,
  presentation,
  everySkill,
  keying,
  window,
  segmentAt,
  enemyTypeAt,
  markEntry,
}: TimelineTabProps) => {
  const { id, metric, hostility, pins, probes } = stream;
  const { rows, rowKind, renderLabel, rowColor, onPin, sectionLabel, emptyKey, rowSections, cardAmount } = presentation;
  const { t } = useTranslation();
  const { events, total } = useEvents(id);
  // Measured so the merge threshold tracks the real scale. `useElementSize`
  // reports 0 before layout, which `markGapMs` treats as "merge nothing".
  const { ref, width } = useElementSize();

  const scope = scopeFor(metric);

  // The Events tab's own narrowing, in the same order, so the marks and that
  // tab's rows are the same events. The kind toggles are deliberately NOT
  // here: they are that tab's sub-filter, and a lane's marks must match the
  // row the lane is, not a separate selection made elsewhere.
  const shown = useMemo(
    () => narrowStream(events.map(toEventRow), { scope, hostility, probes, kinds: defaultScopeKinds(scope), pins }),
    [events, scope, probes, hostility, pins]
  );

  const domainMs = Math.max(0, window.endMs - window.startMs);

  // The fold's threshold serves twice: it decides which marks merge, and it is
  // the unit every width `TimelineTracks` draws is a multiple of. Lifted out of
  // the lane memo so both can read the one value.
  const gapMs = markGapMs({ widthPx: width, viewportMs: TIMELINE_VIEWPORT_MS, gapPx: MARK_GAP_PX });

  const lanes = useMemo(() => {
    const matcher = laneMatcherFor(rows, { everySkill, end: laneEndFor(scope), segmentAt, enemyTypeAt, keying });
    const byLane = marksByLane(shown, matcher, window, keying?.collapseSupplementary ?? false);
    return lanesFor(rows, byLane, gapMs, (row) => laneShapeOf(row, rowKind));
  }, [rows, everySkill, keying, scope, segmentAt, enemyTypeAt, shown, window, gapMs, rowKind]);

  // The cap is the frontend's, not the log's. Said out loud for the same
  // reason the Events tab says it: a fight cut off at 50,000 events would
  // otherwise look like a fight whose lanes simply went quiet.
  const truncated = total > events.length;

  return (
    <div ref={ref}>
      {truncated && (
        <Text size="xs" c="dimmed" mb={4}>
          {t("ui.logs.timeline-truncated", { shown: events.length, total })}
        </Text>
      )}
      <TimelineTracks
        lanes={lanes}
        domainMs={domainMs}
        startMs={window.startMs}
        viewportMs={TIMELINE_VIEWPORT_MS}
        gapMs={gapMs}
        renderLabel={renderLabel}
        rowColor={rowColor}
        onPin={onPin}
        {...(sectionLabel === undefined ? {} : { sectionLabel })}
        {...(emptyKey === undefined ? {} : { emptyKey })}
        {...(rowSections === undefined ? {} : { rowSections })}
        {...(cardAmount === undefined ? {} : { cardAmount })}
        {...(markEntry === undefined ? {} : { markEntry })}
      />
    </div>
  );
};
