import { Box, Text, Tooltip } from "@mantine/core";
import type React from "react";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { humanizeNumber, millisecondsToPreciseElapsedFormat } from "@/utils";

import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import { AnalysisRow } from "../analysis/AnalysisRow";
import { HoverCard, type CardAmount, type CardSection } from "../analysis/HoverCard";
import { ART_SHADOW } from "../analysis/RowArt";

import { TimelineRuler, tickTimes } from "./TimelineRuler";
import { shownHits, type Lane, type LaneMark, type MarkHit } from "./laneMarks";
import { laneRows } from "./laneRows";
import { markCardSections } from "./markCard";

/** How far apart ruler ticks are. Five seconds against the 15s viewport gives
 * three labelled ticks a screen — the labels read `MM:SS`, so a finer step
 * would print the same label twice rather than a finer scale. */
const TICK_STEP_MS = 5000;

/** How far a bucket stands off the lane's own edges.
 *
 * A hairline, not a band: a bucket fills its lane, so the whole row reads as
 * one block of colour and no height is left over to be mistaken for a
 * measurement. Both encodings that DID vary the shape were tried against real
 * damage and both failed — a charge attack is fifty times an auto attack, so
 * any scale that fits the big hit flattens every other one, whether it is
 * spent on height or on brightness. */
const LANE_INSET = 1;

/** One hit's marker: a triangle this wide and this deep, pointing down at the
 * moment the hit landed.
 *
 * Its tip lands on the TOP EDGE OF ITS OWN LANE, so its body stands clear of
 * the bucket it points at. Not inside the bar — a marker there competes with
 * the bar for the same pixels, which is what made the hairlines hard to see and
 * the wedges before them into noise.
 *
 * A bucket fills its lane, so standing clear means overhanging the row above.
 * That is paid for twice: the glyph carries its own drop shadow rather than
 * relying on the ground behind it, and its hit box is clipped to its silhouette
 * so it cannot take the pointer off the bar it is drawn over. */
const ARROW_W = 11;
const ARROW_H = 8;

/** The prism the bar is cut into on a lane that carries art.
 *
 * The concave bite taken out of its left end, which the icon's diamond nests
 * into, and the point its right end comes to — one figure, so one constant:
 * half the lane's height, which is what makes both slopes the diamond's own
 * 45°. Together the icon and the bar read as one shape: a diamond drawn out
 * into a prism, opening at the first hit and closing at the last. */
const PRISM = 20;

/** How short a bucket that carries art may draw.
 *
 * Its bar is the mark plus the `PRISM` it reaches back by, so this floor leaves
 * the bite, the point, and four pixels of body between them. Capping the two
 * heads at a share of the bar instead — which is what this did — is the trade
 * `MetricBar` made and then undid: at a stub depth the bite is shallower than
 * the diamond nesting in it, so the bar's colour shows through the art's own
 * transparent corners, and the head stops being the same figure at every width.
 * A floor on the bar is the honest fix — see `MIN_FILL` there. */
const MIN_HEADED = PRISM + 4;

/** A percentage, at the precision a sub-pixel position needs and no more —
 * `toFixed` keeps the DOM stable across renders where a raw float would not. */
const percent = (value: number, of: number): string => (of === 0 ? "0%" : `${((value / of) * 100).toFixed(4)}%`);

/** Which arrow is under the pointer. */
export type HoveredHit = { label: string; left: string };

/** One hit, as an arrow pointing down at the moment it landed.
 *
 * Above the bucket rather than inside it: a mark drawn INSIDE has to compete
 * with the bar it sits on, which is why the pale hairlines were hard to see and
 * the wedges before them were noise. Out in the lane's own space it has the
 * background to itself. */
const hitArrow = (
  hit: MarkHit,
  key: string,
  domainMs: number,
  tooltip: (hit: MarkHit) => string,
  onEnter: (hovered: HoveredHit) => void,
  onLeave: () => void
) => (
  <Box
    key={key}
    data-hit
    data-echo={hit.echo || undefined}
    onMouseEnter={() => onEnter({ label: tooltip(hit), left: percent(hit.atMs, domainMs) })}
    onMouseLeave={onLeave}
    // The hit box is the whole arrow plus a pixel each side, so a 7px glyph
    // is still catchable by a pointer.
    className="pointer-events-auto absolute cursor-default"
    style={{
      left: percent(hit.atMs, domainMs),
      marginLeft: -ARROW_W / 2 - 1,
      // Clipped to the arrow's own silhouette, because a clip bounds where an
      // element takes the pointer as well as where it paints. The box hangs
      // over the lane ABOVE — that is where the glyph is drawn — and as a
      // rectangle its two top corners, which are bare neighbouring bar, took
      // the hover with it: the lane below's hit tooltip opened over the lane
      // above's bucket, and that bucket's own card was torn down while the
      // pointer still looked to be on it. Clipped, an arrow can only steal the
      // pixels it actually covers.
      clipPath: "polygon(0 0, 100% 0, 50% 100%)",
      // Entirely ABOVE the bar, tip against its top edge. The bar fills the
      // lane, so this overhangs the row — which is what the lane not clipping
      // is for. Inside the bar it would be competing with the bar for the same
      // pixels, which is what made every marker before it either invisible or
      // noise.
      top: LANE_INSET - ARROW_H,
      width: ARROW_W + 2,
      height: ARROW_H + LANE_INSET,
    }}
  >
    <Box
      className={[
        "absolute left-1/2 top-0 -translate-x-1/2 transition-transform",
        "border-x-transparent hover:scale-125",
      ].join(" ")}
      style={{
        width: 0,
        height: 0,
        borderLeftWidth: ARROW_W / 2,
        borderRightWidth: ARROW_W / 2,
        borderLeftStyle: "solid",
        borderRightStyle: "solid",
        borderTopWidth: ARROW_H,
        borderTopStyle: "solid",
        borderTopColor: hit.echo ? "rgba(232,234,237,0.45)" : "#e8eaed",
        // The marker overhangs whatever lane sits above, so it carries its own
        // separation rather than relying on the ground behind it.
        filter: "drop-shadow(0 0 1px rgba(0,0,0,0.75))",
      }}
    />
  </Box>
);

/** The arrows over one lane, and the ONE tooltip they share.
 *
 * One tooltip for the lane rather than one per arrow: a three-minute fight puts
 * thousands of arrows in this column, and a tooltip apiece would mount
 * thousands of floating-UI instances to serve the one under the pointer.
 *
 * It is the SAME `Tooltip` a bucket opens, with the same props — anything else
 * would give one timeline two tooltip styles. Since the hovered arrow is not
 * the tooltip's own child, it is anchored instead to a hairline box parked at
 * the arrow's position and opened by hand.
 *
 * Takes the hits already thinned (see `shownHits`) rather than a callback that
 * renders them: hovering an arrow sets state HERE, so anything this component
 * recomputes on hover is recomputed once per arrow crossed.
 *
 * Which is why the arrows themselves are MEMOISED, and not just the thinning
 * that feeds them: the tooltip's state lives here, so a lane that keeps a
 * thousand arrows after thinning was rebuilding all thousand elements on every
 * enter and again on every leave — two full lane renders per arrow the pointer
 * crossed. Held by reference, React skips the whole set and reconciles only the
 * one tooltip that actually changed. */
const LaneArrows = ({
  hits,
  tooltip,
  domainMs,
}: {
  hits: Array<{ hit: MarkHit; key: string }>;
  tooltip: (hit: MarkHit) => string;
  domainMs: number;
}) => {
  const [hovered, setHovered] = useState<HoveredHit | null>(null);
  const onLeave = useCallback(() => setHovered(null), []);
  const arrows = useMemo(
    () => hits.map(({ hit, key }) => hitArrow(hit, key, domainMs, tooltip, setHovered, onLeave)),
    [hits, domainMs, tooltip, onLeave]
  );
  return (
    // The layer takes no pointer events of its own — only the arrows do — or it
    // would sit over the buckets and swallow the hover that opens their card.
    <Box className="pointer-events-none absolute inset-0">
      {arrows}
      {hovered && (
        <Tooltip label={hovered.label} opened withinPortal>
          <Box
            aria-hidden
            className="absolute"
            style={{ left: hovered.left, top: LANE_INSET - ARROW_H, width: 1, height: ARROW_H }}
          />
        </Tooltip>
      )}
    </Box>
  );
};

export type TimelineTracksProps = {
  lanes: Lane[];
  /** The window's length in milliseconds — what 100% of a track is. */
  domainMs: number;
  /** The window's start in absolute fight time, for the ruler's labels. */
  startMs: number;
  /** Milliseconds shown per viewport width. The content is widened by
   * `domainMs / viewportMs`, which fixes the scale without measuring. */
  viewportMs: number;
  /** The density fold's own threshold, in milliseconds — what three pixels are
   * worth at the current scale (see `markGapMs`). Every width this component
   * decides is a multiple of it, which is how it sizes marks in pixels while
   * positioning them in percentages and measuring nothing itself. Zero before
   * the container has been measured, which draws every mark at its true width
   * and nothing wider. */
  gapMs: number;
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
 * Two columns: the lane names, fixed, and the tracks, which own the only
 * scrollbar in the block. Both columns map the single `laneRows` sequence, so
 * neither can invent a row the other does not have.
 *
 * NO vertical scroller of its own — the block grows to its full height and the
 * page scrolls it. A `max-height` here is what broke the two columns before: a
 * single-line flex container clamps its line to its own max cross size, so
 * BOTH columns were stretched to the frame's height rather than their
 * content's. The names spilled (`overflow: visible`) and scrolled with the
 * frame, while the tracks — forced to `overflow-y: auto` by their own
 * `overflow-x` — clipped instead, so they kept a second vertical scrollbar and
 * ran out part-way down while the names kept going.
 *
 * They stay in step only while their row heights match EXACTLY, so each pair
 * reads the SAME token rather than restating a number:
 *
 *   ruler    `h-head`  TimelineRuler   ↔  the names column's opening gap
 *   heading  `h-head`  the heading     ↔  the tracks column's gap row
 *   lane     `h-lane`  `AnalysisRow`   ↔  the lane row
 *
 * A lane IS an `AnalysisRow`, and the track beside it has to be exactly as
 * tall. Stated twice, the two columns drift apart the first time one is
 * nudged.
 *
 * A lane is TALLER than the table's own row (`h-lane`, not `h-row`): a track
 * carries marks, the wedges ticked inside them and a hover target for each,
 * where a table row carries one line of text. The table keeps its own height —
 * one token per body, so making the timeline breathe cannot silently stretch
 * every other view built out of `AnalysisRow`. */
export const TimelineTracks = ({
  lanes,
  domainMs,
  startMs,
  viewportMs,
  gapMs,
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

  // The thinned arrows per lane, resolved once per lane set rather than once
  // per render. `shownHits` walks a mark's FULL hit list, so rebuilding this in
  // the render body was one pass over every event in the window — repeated on
  // every hover, pan and live push, and again on each of the two state updates
  // an arrow's own hover fires.
  const arrowsByLane = useMemo(
    () =>
      new Map(
        lanes.map((lane) => [
          lane.row.key,
          lane.shape === "spans"
            ? []
            : lane.marks.flatMap((mark) =>
                // The marker is thinned by its own width plus the pixel each
                // side that makes it catchable — the box `hitArrow` draws.
                shownHits(mark.hits, gapMs, ARROW_W + 2).map((hit, index) => ({
                  hit,
                  key: `${mark.startMs}:${index}`,
                }))
              ),
        ])
      ),
    [lanes, gapMs]
  );

  // One array for the whole column rather than one per render: the ticks depend
  // on the domain alone, and the grid draws a node per tick.
  const gridTicks = useMemo(
    () =>
      tickTimes(domainMs, TICK_STEP_MS / 2)
        // Not at zero: the frame's own border already stands there.
        .slice(1),
    [domainMs]
  );

  /** What ONE hit says when you point at its arrow. The bucket's own tooltip
   * can only report the run — how many hits and what they came to together —
   * so without this the individual hit a marker points at is unreadable.
   *
   * Up here with the memos, unlike the other render helpers below, because it
   * is a `LaneArrows` DEPENDENCY: rebuilt every render it would invalidate that
   * component's memo on every pan and every live push, which is most of what
   * the memo exists to survive. */
  const hitTooltip = useCallback(
    (hit: MarkHit): string => {
      const parts = [
        markEntry?.(hit.key).name ?? "",
        t("ui.logs.timeline-mark-at", { time: millisecondsToPreciseElapsedFormat(startMs + hit.atMs) }),
      ].filter(Boolean);
      if (hit.amount !== null) parts.push(t("ui.logs.timeline-mark-amount", { amount: humanizeNumber(hit.amount) }));
      return parts.join(" · ");
    },
    [markEntry, startMs, t]
  );

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
    if (lane.shape === "spans") {
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
      <AnalysisRow
        className="h-lane"
        name={renderLabel(lane.row)}
        onClick={pinOnClick ? () => onPin(pinOnClick) : undefined}
      />
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

  /** One bucket: a run of ONE ability, at one height and one brightness.
   *
   * Nothing about the bar varies with damage. Height and brightness both got
   * tried and both failed on real data — a charge attack is fifty times an auto
   * attack, so any scale that fits the big hit flattens every other one. What
   * the bar says is "this ability, from here to here"; what it hit for is the
   * tooltip's job, and when each hit landed is the arrows'. */
  const bucketMark = (mark: LaneMark, color: string, art?: { name: string; iconUrl?: string }) => {
    const spanMs = mark.endMs - mark.startMs;
    const iconUrl = art?.iconUrl;
    return (
      <Box
        data-mark
        data-mark-kind="bucket"
        className="absolute opacity-90"
        style={{
          left: percent(mark.startMs, domainMs),
          width: percent(spanMs, domainMs),
          // A single hit has no duration to draw, so it takes a readable
          // minimum instead of the sliver it measures, and gives back half of
          // it on the left so the shape still centres on the moment it landed.
          // A headed bar takes the wider floor its two heads need, and keeps
          // its left edge exactly on the first hit — that edge is where the
          // art's corner meets it.
          minWidth: iconUrl ? MIN_HEADED : 4,
          marginLeft: iconUrl || spanMs * 3 >= gapMs ? 0 : -2,
          top: LANE_INSET,
          bottom: LANE_INSET,
        }}
      >
        {/* The bar is a CHILD, not this box itself: `clip-path` clips an
            element's descendants too, so a bar that clipped itself would clip
            away the icon hanging off its left edge.

            On an art lane it reaches BACK past the first hit by the notch's
            depth, so that the notch's own point — not the bar's left edge —
            lands on the moment the run opened. */}
        <Box
          className="absolute inset-y-0"
          style={{
            left: iconUrl ? -PRISM : 0,
            right: 0,
            backgroundColor: color,
            ...(iconUrl
              ? {
                  // Never a share of the bar: the bite is the DIAMOND's right
                  // half, so a depth that varies with width stops matching the
                  // art it is cut for. `MIN_HEADED` is what keeps the two heads
                  // from meeting.
                  clipPath: [
                    "polygon(0 0",
                    `calc(100% - ${PRISM}px) 0`,
                    "100% 50%",
                    `calc(100% - ${PRISM}px) 100%`,
                    "0 100%",
                    // Back up into the concave bite the diamond sits in.
                    `${PRISM}px 50%)`,
                  ].join(", "),
                }
              : { borderRadius: 2 }),
          }}
        />
        {/* An ability lane can name its marks with the skill's own art; a lane
            pooling a player's whole rotation cannot, because every bucket in it
            is a different skill. */}
        {art?.iconUrl && (
          <Box
            component="img"
            src={art.iconUrl}
            alt=""
            data-mark-icon
            // Its RIGHT corner sits on the first hit, so the art reads as the
            // head of the run rather than as a lid centred over its start. The
            // game's ability art is already a diamond with transparent corners
            // — no frame around it, or the frame boxes in those corners.
            //
            // As tall as the bucket itself, so it scales with the density
            // setting for free. `h-full`, NOT `inset-y-0`: an image is a
            // replaced element, so a top/bottom pair does not size it — its
            // `height` stays `auto`, which for an image means its INTRINSIC
            // height, and the art is 322px square.
            className={`absolute top-0 aspect-square h-full object-contain ${ART_SHADOW}`}
            style={{ right: "100%" }}
          />
        )}
      </Box>
    );
  };

  /** One uptime span: a wash to the lane's ceiling under a lit rule.
   *
   * Ambient state rather than a bar. Drawn as a bar it was simply the biggest
   * block on the screen, and a buff that is up for half the fight would drown
   * out every hit beneath it. */
  const spanMark = (mark: LaneMark, color: string) => (
    <Box
      data-mark
      data-mark-kind="span"
      className="absolute"
      style={{
        left: percent(mark.startMs, domainMs),
        width: percent(mark.endMs - mark.startMs, domainMs),
        minWidth: 2,
        top: LANE_INSET,
        bottom: LANE_INSET,
      }}
    >
      {/* Two children rather than one box with an opacity: an `opacity` fades
          the whole element, so the rule that is supposed to be lit would be
          washed out with the wash it sits under. */}
      <Box className="absolute inset-0 rounded-t-[2px] opacity-[0.16]" style={{ backgroundColor: color }} />
      <Box className="absolute inset-x-0 bottom-0 h-[2px]" style={{ backgroundColor: color }} />
    </Box>
  );

  // A mark WITH contributions opens the table's own card; a mark without — a
  // status row's real span — keeps the concise tooltip, which is the only thing
  // that can report a duration.
  const laneMarks = (lane: Lane) => {
    const color = rowColor(lane.row);
    return lane.marks.map((mark) => {
      const key = `${mark.startMs}:${mark.endMs}`;
      const sections = sectionsByMark?.get(`${lane.row.key}:${key}`) ?? [];
      // Only an ability lane can name its marks with art: every bucket in it is
      // the same skill. A player's lane pools their whole rotation.
      const art = lane.shape === "icons" ? markEntry?.(mark.by[0]?.key ?? "") : undefined;
      const markNode = lane.shape === "spans" ? spanMark(mark, color) : bucketMark(mark, color, art);
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

  // A spans lane has no hits to mark, and a lane whose hits all folded together
  // has nothing left to draw — neither needs the layer mounted.
  const laneArrows = (lane: Lane) => {
    const hits = arrowsByLane.get(lane.row.key) ?? [];
    if (hits.length === 0) return null;
    return <LaneArrows hits={hits} tooltip={hitTooltip} domainMs={domainMs} />;
  };

  return (
    <Box style={{ padding: "4px 16px 14px" }}>
      {/* The vertical scroller. Both columns live in it, so they scroll down
          together; only the right one scrolls sideways. */}
      <Box className="flex rounded-sm border border-line" role="group" aria-label={t("ui.logs.timeline-label")}>
        {/* Outside the horizontal scroller, so the names cannot pan away and
            need no stickiness. Opaque, and separated by its own border. */}
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

        {/* The ONLY scrollbar in the block, and it spans this column alone —
            across the whole frame it sits under the names too and reads as if
            they scrolled with it. `min-w-0` so the flex item may shrink below
            its (very wide) content instead of stretching the frame. */}
        <Box data-tracks-scroll className="min-w-0 flex-1 overflow-x-auto">
          {/* Widened by exactly domain/viewport, so percentages inside address
              the whole window and the scale needs no measurement. */}
          <Box
            data-timeline-content
            className="relative min-w-full"
            style={{ width: `${(domainMs / viewportMs) * 100}%` }}
          >
            {/* One overlay for the whole block rather than a set per lane: the
                lines are continuous down the column, and a lane that drew its
                own would cost a node per lane per tick. First child, so every
                mark paints over it. */}
            <Box
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0"
              // Below the ruler, so the lines start where the lanes do and no
              // minor line crosses a label.
              style={{ top: "var(--spacing-head)" }}
            >
              {gridTicks.map((at) => (
                <Box
                  key={at}
                  data-grid-line
                  // Major where the ruler has a label, minor between. A minor
                  // line as strong as a labelled one would read as a tick the
                  // ruler had forgotten to name.
                  className={[
                    "absolute inset-y-0 w-px",
                    at % TICK_STEP_MS === 0 ? "bg-white/[0.07]" : "bg-white/[0.03]",
                  ].join(" ")}
                  style={{ left: percent(at, domainMs) }}
                />
              ))}
            </Box>

            <TimelineRuler domainMs={domainMs} startMs={startMs} stepMs={TICK_STEP_MS} />

            {rows.map((row) =>
              row.kind === "heading" ? (
                // The heading's height with none of its text: the names column
                // carries the words, this column only has to stay level.
                <Box key={row.key} data-lane-gap className="h-head" aria-hidden />
              ) : (
                <Box key={row.key} data-lane-row className="flex h-lane items-stretch hover:bg-white/5">
                  {/* The rule every shape stands on, so an empty lane reads as
                      "nothing here" rather than as a missing cell — and so a
                      silhouette lane and a cast lane share one floor. */}
                  <Box className="relative min-w-0 flex-1">
                    {laneMarks(row.lane)}
                    {/* After the buckets, so an arrow is never painted over by
                        the bucket of the mark that follows it. */}
                    {laneArrows(row.lane)}
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
