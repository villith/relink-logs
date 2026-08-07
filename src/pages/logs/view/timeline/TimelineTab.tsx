import { Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { EnemyType, SkillRow } from "@/types";

import type { RowKeying } from "../abilitySkills";
import type { MetricKey } from "../analysis/machine/state";
import type { RowPresentation, StreamContext } from "../analysis/model/bodyContext";
import type { ActorSpace } from "../events/eventRows";
import { filterByKind, filterByPins, toEventRow } from "../events/eventRows";
import {
  defaultScopeKinds,
  filterByHolderSide,
  filterByScope,
  scopeFor,
  scopeUsesHostility,
} from "../events/eventScope";
import { useEvents } from "../events/useEvents";
import type { Span } from "../spans";

import { TimelineTracks } from "./TimelineTracks";
import { lanesFor, markGapMs, marksByLane } from "./laneMarks";
import { laneMatcherFor } from "./laneMatch";

/** How much time one viewport width shows. Warcraft Logs' own timeline is far
 * tighter than this (fifteen seconds of a six-minute fight); thirty keeps a
 * whole rotation on screen without the marks smearing together. */
export const TIMELINE_VIEWPORT_MS = 30_000;

/** How close two marks may come before they are drawn as one. Three pixels:
 * below that the gap between two ticks is not visible anyway, so drawing them
 * separately just makes a smear that pretends to be two readable marks. */
const MARK_GAP_PX = 3;

/** Which end of a damage event a metric's lanes are keyed by. `taken` reads
 * the same hits from the victim's end, exactly as `filterByScope`'s direction
 * test does — so its player lanes are victims, not attackers. */
const laneEndFor = (metric: MetricKey): "source" | "target" => (metric === "taken" ? "target" : "source");

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
  const { rows, renderLabel, rowColor, onPin, sectionLabel, emptyKey, rowSections, cardAmount } = presentation;
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
  const shown = useMemo(() => {
    const all = events.map(toEventRow);
    const inScope = filterByScope(all, scope, probes);
    const sided = scopeUsesHostility(scope) ? filterByHolderSide(inScope, hostility, probes) : inScope;
    return filterByPins(filterByKind(sided, defaultScopeKinds(scope)), pins);
  }, [events, scope, probes, hostility, pins]);

  const domainMs = Math.max(0, window.endMs - window.startMs);

  const lanes = useMemo(() => {
    const matcher = laneMatcherFor(rows, { everySkill, end: laneEndFor(metric), segmentAt, enemyTypeAt, keying });
    const byLane = marksByLane(shown, matcher, window, keying?.collapseSupplementary ?? false);
    const gapMs = markGapMs({ widthPx: width, viewportMs: TIMELINE_VIEWPORT_MS, gapPx: MARK_GAP_PX });
    return lanesFor(rows, byLane, gapMs);
  }, [rows, everySkill, keying, metric, segmentAt, enemyTypeAt, shown, window, width]);

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
