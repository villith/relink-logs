import { AreaChart, LineChart } from "@mantine/charts";
import { Box, Checkbox, Group, Paper, Text } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReferenceArea, ReferenceLine } from "recharts";

import { AnimatedHeight } from "@/components/AnimatedHeight";
// Aliased: `Label` in this file is the chart's own series-label type.
import { Label as UiLabel } from "@/components/ui/Label";
import { PillGroup } from "@/components/ui/PillGroup";
import { useCtrlHeld } from "@/components/useCtrlHeld";
import { humanizeNumber } from "@/utils";

import { DPS_BUCKET_MS, type ChartDatapoint, type Label } from "../DetailCharts";
import { bandOpacity, type Band } from "../statusBands";

import { ChartLegend } from "./ChartLegend";
import { CardNotes, HoverCardBody } from "./HoverCard";
import "./analysis.css";
import type { ChartMarker, MarkerKind } from "./chartMarkers";
import { ROLLUP_SERIES_KEY, rollupIsDrawn, withRollupSeries } from "./chartRollup";
import { TOTAL_SERIES_KEY } from "./chartSeries";
import {
  WINDOW_BAND_COLOR,
  WINDOW_KINDS,
  WINDOW_LABEL_KEY,
  type WindowBand,
  type WindowKind,
} from "./chartWindowBands";
import type { WindowTooltipEntry } from "./chartWindowTooltip";
import { windowFromDrag } from "./scopeWindow";

/** How a plotted value reads as text.
 *
 * One spelling for both readers of it — the axis/tooltip `valueFormatter` and
 * the custom tooltip rows — which have to agree or the same point reads two
 * ways depending on where the cursor is. */
export const formatChartValue = (format: DpsChartProps["format"], value: number): string => {
  if (format === "percent") return `${value}%`;
  if (format === "count") return String(value);
  return humanizeNumber(value);
};

/** How the stacks chart composes its series: Warcraft Logs' "Normal"
 * (overlapping areas — the default) or summed into a stack. */
export type StackMode = "normal" | "stacked";

/** Selectable trailing-average windows, in buckets. One bucket is one second
 * (`DPS_BUCKET_MS`), so a value IS its duration in seconds; 1 is "off", since a
 * one-bucket trailing mean is the bucket itself. */
const SMOOTHING_OPTIONS = [1, 5, 10, 30];

export type DpsChartProps = {
  /** Already sliced to the committed window, so the chart IS the window. */
  data: ChartDatapoint[];
  labels: Label;
  /** i18next key naming what is plotted; follows the metric tabs. */
  labelKey: string;
  /** i18next key naming what ONE SERIES is — the table's row-label key, which
   * heads the tooltip's breakdown so the card and the rows beneath it name the
   * same thing. Distinct from `labelKey`, which names the whole plot. */
  sectionKey: string;
  /** How a value reads: a humanized amount, a gauge percentage, or a plain
   * integer count (a stack depth, which `humanizeNumbers` would render as
   * "3.0" and a percent sign would misdescribe). */
  format: "amount" | "percent" | "count";
  /** Commits a window as bucket indexes RELATIVE TO `data`, or null to clear. */
  onScope: (window: [number, number] | null) => void;
  /** Stack the series as filled bands instead of drawing them independently.
   *
   * The drill-down levels are a decomposition — a player's damage split by skill
   * group, an ability's split by target — so the bands compose a total that is
   * itself meaningful, and the stack's height keeps showing it. Independent
   * lines are right at the players level, where four players' curves are
   * compared rather than added. */
  stacked?: boolean;
  /** Status-effect windows to shade, already rebased onto this chart's window
   * by `toBands`. NOTHING passes any today — don't go hunting for the caller;
   * the capability is kept for the approved "Source/Target Auras Filter"
   * follow-up, which is the next thing to feed it. Absent, the chart draws
   * exactly what it draws today. */
  bands?: { color: string; band: Band }[];
  /** Battle-state windows (SBA performances, Link Time, enemy Breaks), already
   * clipped and rebased like `bands` — see `windowBandsFor`. Same shading
   * mechanism, but each KIND gets its own control-row toggle beside the marker
   * checkboxes, because the three overlap and reading one often means hiding
   * the others. */
  windowBands?: WindowBand[];
  /** Hoverable battle-window lines: appended to the tooltip of every bucket
   * the window covers, the markers' mechanism generalised from a point to a
   * span. Hidden window KINDS (the checkbox row) suppress their lines. */
  windowTooltips?: WindowTooltipEntry[];
  /** Death/SBA event markers, already rebased onto this chart's window (like
   * `bands`). Drawn as vertical reference lines and appended to the tooltip of
   * the bucket they land in; a control row above the plot toggles each kind. */
  markers?: ChartMarker[];
  /** For the STACKS chart (aura holder/effect series): whether the areas
   * overlap ("normal", WCL's default) or sum into a stack. Absent, a stacked
   * chart stacks — the damage drills are decompositions whose stack height IS
   * the total, and they get no toggle.
   *
   * Layered under `stacked` above, which is the coarser choice: `stacked`
   * picks an AreaChart over a LineChart at all, and only then does this pick
   * that AreaChart's internal type. Meaningless when `stacked` is false.
   *
   * The default here reads as a contradiction against AnalysisView's
   * `useState<StackMode>("normal")` — deliberately, because the two reach
   * disjoint cases. This default applies ONLY where the prop is omitted, which
   * is exactly the charts that never get a toggle (the drills), and it keeps
   * them stacking as they always have; the "normal" there is the toggle's own
   * opening position on the one chart that has one. */
  /** The trailing smoothing window in BUCKETS (one bucket is one second), and
   * its setter. Both present = the control is shown.
   *
   * RATE charts only. Smoothing a LEVEL is exactly what `chartPresentation`'s
   * `smoothing: 1` exists to prevent — averaged, the SBA gauge's discharge and
   * an aura's stack steps turn into ramps — so the caller withholds the setter
   * there rather than the control silently doing nothing. */
  smoothing?: number;
  onSmoothingChange?: (buckets: number) => void;
  stackMode?: StackMode;
  /** Providing this renders the Normal | Stacked SegmentedControl in the
   * chart header. */
  onStackModeChange?: (mode: StackMode) => void;
};

/** The glyph a marker's reference line wears at the top of the plot. Kept out
 * of JSX text (recharts label props) so the i18next literal rule stays clean;
 * the tooltip lines carry their own translated text instead. */
const MARKER_GLYPH: Record<MarkerKind, string> = { death: "☠", sba: "✦" };

/** The stroke a deduped marker line takes when the markers it stands for do NOT
 * agree on a colour — two players dying in one bucket, each in their own party
 * colour. Neither colour is right for the single line, and keeping the first
 * would silently claim the bucket for one of them, so it goes neutral (the same
 * grey the Total series uses) and the tooltip, which still lists every marker,
 * names who died. */
const MIXED_MARKER_COLOR = "var(--mantine-color-gray-5)";

/** The chart tooltip's width, in pixels.
 *
 * FIXED, not fitted. Sized to its content the card was as wide as the longest
 * label in whichever bucket the cursor was over, so it changed width — and,
 * being right-anchored by recharts near the plot's right edge, jumped
 * sideways — as the pointer crossed the plot. Wide enough for the four-column
 * row at the labels the view produces; longer names ellipsize, which the card's
 * own name cell already does in the table.
 *
 * Its own constant rather than `HoverCard`'s min/max pair: those bound a card
 * whose content is fixed by the row it explains, and are free to fit it. */
const TOOLTIP_WIDTH = 320;

/** Control-row label per marker kind. */
const MARKER_LABEL_KEY: Record<MarkerKind, string> = {
  death: "ui.logs.chart-marker-deaths",
  sba: "ui.logs.chart-marker-sba",
};

// recharts types a tooltip entry as Payload<any, any>, which has no index
// signature; the same `any` escape hatch as DetailCharts' tooltip.
export const ChartTooltip = ({
  label,
  payload,
  format,
  labels,
  sectionKey,
  markers,
  windowLines,
  sumTotal = false,
}: {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
  format: "amount" | "percent" | "count";
  /** The series descriptors, so a payload entry can be named. */
  labels: Label;
  /** i18next key naming what the breakdown's rows ARE under the caller's
   * grouping — the table's own row-label key, so the card and the rows beneath
   * it name one thing. Fixed, this read "At this moment", which names the
   * BUCKET rather than the column under it and said the same word over
   * players, abilities and enemies alike. */
  sectionKey: string;
  /** Event markers that landed in THIS bucket, already named and coloured —
   * appended under the series rows, Warcraft Logs' behavior. */
  markers?: ChartMarker[];
  /** Battle-window lines covering THIS bucket, already coloured and worded —
   * appended under the marker rows, grouped by kind under their own headings
   * (so the row text no longer names its own kind). */
  windowLines?: { kind: WindowKind; color: string; text: string }[];
  /** Whether the bucket's total is the SUM of the plotted series.
   *
   * True on a stacked chart, where the stack's height IS the total and no
   * Total series is plotted (one inside a Mantine stacked AreaChart would be
   * added to the stack and double it) — so the card computes the figure the
   * plot already draws. False where the series overlap rather than compose
   * (the aura stacks' Normal mode), because nothing there sums to anything.
   * A plotted Total series wins over this: it is the exact figure. */
  sumTotal?: boolean;
}) => {
  // ABOVE the guard below: these are hooks, and a conditional one is a bug even
  // when the condition looks stable. The chart tooltip mounts `HoverCardBody`
  // directly rather than through `HoverCard`, so it makes the key read itself
  // — otherwise the one card of the three that skips the shell would be the
  // one that never answers the modifier.
  const detailed = useCtrlHeld();
  const { t } = useTranslation();

  if (!payload) return null;

  // Mantine hands recharts `name: item.name` — the series KEY, not its label
  // (AreaChart.mjs) — so the payload cannot name itself. Mantine's own legend
  // hides this by looking the key up through `getSeriesLabels`; ours has to do
  // the same, or it prints actor indexes and group keys at the user.
  const labelByKey = new Map(labels.map((series) => [series.name, series.label ?? series.name]));
  // The art each series carries, resolved once by the chart model off the same
  // key grammar its name comes from (see `entity.ts`). Keyed like the labels
  // above, for the same reason: the payload can only name its series key.
  const iconByKey = new Map(labels.map((series) => [series.name, series.icon]));

  // Only what actually landed in this bucket, largest first. A stack of 17
  // skill-group bands is mostly zeroes at any one moment, and listing every one
  // of them buries the few that fired. The payload arrives in SERIES order,
  // which ranks the whole fight — at any one second the biggest contributor is
  // rarely the first band. A zero reads the same on the gauge tab: "0%" says
  // nothing the absent row does not.
  const nonZero = payload.filter((item) => typeof item.value === "number" && item.value !== 0);

  // The Total is a SERIES like any other in the payload, and left in the
  // breakdown it behaved like one: it ranked above every player it sums, and
  // counting it in the section's own total halved everyone's share. It is the
  // sum OF the breakdown, not a member of it, so it gets its own section.
  const total = nonZero.find((item) => String(item.dataKey) === TOTAL_SERIES_KEY);

  const landed = nonZero
    .filter((item) => String(item.dataKey) !== TOTAL_SERIES_KEY)
    .sort((a, b) => (b.value as number) - (a.value as number));

  // What the Total row reports, and what it is called. The plotted series when
  // there is one; otherwise the sum the stack already draws as its height.
  // Summed over ALL of `landed`, never the five the section shows — the cap is
  // a display limit, and a total that honoured it would not be a total.
  const totalValue =
    total !== undefined
      ? (total.value as number)
      : sumTotal && landed.length > 0
        ? landed.reduce((sum, item) => sum + (item.value as number), 0)
        : null;
  const totalLabel =
    total !== undefined ? labelByKey.get(String(total.name)) ?? String(total.name) : t("ui.logs.chart-total-label");

  // Markers and battle windows, grouped by KIND so each gets one heading
  // rather than one per line. Both walk a fixed kind order, not the arrival
  // order, so a bucket holding an SBA and a Break always reads the same way.
  const markerSections = (["death", "sba"] as const)
    .map((kind) => ({
      kind,
      notes: (markers ?? [])
        .filter((marker) => marker.kind === kind)
        .map((marker, index) => ({ key: `${kind}-${index}`, color: marker.color, text: marker.label })),
    }))
    .filter((section) => section.notes.length > 0);

  const windowSections = WINDOW_KINDS.map((kind) => ({
    kind,
    notes: (windowLines ?? [])
      .filter((line) => line.kind === kind)
      .map((line, index) => ({ key: `${kind}-${index}`, color: line.color, text: line.text })),
  })).filter((section) => section.notes.length > 0);

  // Hidden, never unmounted. Recharts positions its wrapper by transform only
  // while the measured box is non-zero (`getTooltipTranslate`), and then
  // force-sets `visibility: visible` over its own hidden style — so a zero-size
  // box paints the card at the wrapper's origin, the plot's top-left corner.
  // It stays parked there until the next mouse move, because `updateBBox`
  // mutates a field rather than state. Measured before this guard: 4 of 31
  // samples across the plot painted at the plot's own left edge.
  //
  // `visibility` and not a null return, because it keeps the box in layout —
  // an empty box is the very thing that parks the wrapper.
  const nothingToShow = nonZero.length === 0 && (markers?.length ?? 0) === 0 && (windowLines?.length ?? 0) === 0;

  // One row slot per PLOTTED series, so the breakdown keeps its height as
  // bands fall to zero and drop out of it. Counted off the payload rather than
  // `labels`, which lists the series the legend has hidden too — recharts
  // sends exactly what it drew. The Total is excluded: it is the sum OF the
  // breakdown and has its own section, so reserving a row for it would leave
  // one blank line in every card.
  const reserve = payload.filter((item) => String(item.dataKey) !== TOTAL_SERIES_KEY).length;

  return (
    <Paper
      data-testid="chart-tooltip"
      px="md"
      py="sm"
      withBorder
      shadow="md"
      radius="md"
      style={{ width: TOOLTIP_WIDTH, ...(nothingToShow ? { visibility: "hidden" } : {}) }}
    >
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {/* What the reserved slots cannot hold still: the marker and window
          sections below are whole sections appearing and disappearing with the
          bucket, so the card travels between the two heights instead of
          snapping. */}
      <AnimatedHeight>
        <HoverCardBody
          sections={[
            {
              headingKey: sectionKey,
              reserve,
              // Per-entry colour overrides this; the section colour is only
              // the fallback for an entry recharts gave no colour.
              color: "var(--color-ink-3)",
              entries: landed.map((item) => {
                const icon = iconByKey.get(String(item.name));
                return {
                  // Keyed by dataKey, not name: two players can share a display
                  // label, and React drops the duplicate row.
                  key: String(item.dataKey),
                  label: labelByKey.get(String(item.name)) ?? String(item.name),
                  value: item.value as number,
                  color: item.color as string,
                  // Absent where the entity has none — a row without art stays
                  // text-only rather than reserving a blank box.
                  ...(icon === undefined ? {} : { icon }),
                };
              }),
            },
            // Below the breakdown it sums, headingless — the section separator
            // already divides the two, and a heading reading "Total" over a
            // lone row labelled "Total" says the word twice.
            ...(totalValue === null
              ? []
              : [
                  {
                    headingKey: TOTAL_SERIES_KEY,
                    color: "var(--color-ink-3)",
                    showHeading: false,
                    showShare: false,
                    entries: [
                      {
                        key: TOTAL_SERIES_KEY,
                        label: totalLabel,
                        value: totalValue,
                        // The neutral ink a plotted Total already wears, so the
                        // computed one reads as the same thing.
                        color: (total?.color as string) ?? "var(--mantine-color-gray-5)",
                      },
                    ],
                  },
                ]),
          ]}
          amountKey="ui.logs.column-amount"
          format={(value) => formatChartValue(format, value)}
          detailed={detailed}
        />
        {/* Markers and window lines carry no value, and a BreakdownEntry
            requires one — inventing a number for a death marker to fit it into
            a section would be worse than keeping these apart. They keep the
            card's own section shell instead, minus the columns they cannot
            fill. */}
        {markerSections.map((section) => (
          <CardNotes key={`marker-${section.kind}`} headingKey={MARKER_LABEL_KEY[section.kind]} notes={section.notes} />
        ))}
        {windowSections.map((section) => (
          <CardNotes key={`window-${section.kind}`} headingKey={WINDOW_LABEL_KEY[section.kind]} notes={section.notes} />
        ))}
      </AnimatedHeight>
    </Paper>
  );
};

/** Per-player DPS, and the drag that scopes the analysis window.
 *
 * The drag is recharts', not ours: `onMouseDown`/`onMouseMove`/`onMouseUp` carry
 * `activeTooltipIndex`, which is the bucket index under the pointer, and a
 * `<ReferenceArea>` child draws the band in chart space. Nothing here measures
 * the DOM.
 *
 * Committing does not shade — it re-slices. The parent hands back `data` cropped
 * to the window, so the chart becomes the window and the band has nothing left
 * to mark. */
export const DpsChart = ({
  data,
  labels,
  labelKey,
  sectionKey,
  format,
  onScope,
  stacked = false,
  bands,
  windowBands,
  windowTooltips,
  markers,
  smoothing,
  onSmoothingChange,
  stackMode = "stacked",
  onStackModeChange,
}: DpsChartProps) => {
  const { t } = useTranslation();
  const anchor = useRef<number | null>(null);
  const [band, setBand] = useState<[number, number] | null>(null);

  // Series the user has clicked off in the legend. Mantine 7.6.1 cannot do this
  // itself — its legend has no click handler and no hidden state.
  //
  // Hiding a band lowers the stack, so the plot stops showing the player's whole
  // output. That is accepted deliberately: comparing two groups directly is the
  // reason to hide the others.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Which marker KINDS are hidden. Component-local like the legend's hidden
  // set, but not reset with it: hiding deaths is a way of reading every chart,
  // not a property of one pin's series keys.
  const [hiddenMarkerKinds, setHiddenMarkerKinds] = useState<Set<MarkerKind>>(new Set());

  const markerKinds = useMemo(
    () => (["death", "sba"] as const).filter((kind) => (markers ?? []).some((marker) => marker.kind === kind)),
    [markers]
  );

  // Which window KINDS are hidden — same lifecycle reasoning as the marker
  // kinds: a way of reading every chart, not a property of one pin's series.
  const [hiddenWindowKinds, setHiddenWindowKinds] = useState<Set<WindowKind>>(new Set());

  const windowKinds = useMemo(
    () => WINDOW_KINDS.filter((kind) => (windowBands ?? []).some((band) => band.kind === kind)),
    [windowBands]
  );

  const shownWindowBands = useMemo(
    () => (windowBands ?? []).filter((band) => !hiddenWindowKinds.has(band.kind)),
    [windowBands, hiddenWindowKinds]
  );

  const toggleWindowKind = (kind: WindowKind) =>
    setHiddenWindowKinds((previous) => {
      const next = new Set(previous);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  const shownMarkers = useMemo(
    () => (markers ?? []).filter((marker) => !hiddenMarkerKinds.has(marker.kind)),
    [markers, hiddenMarkerKinds]
  );

  const toggleMarkerKind = (kind: MarkerKind) =>
    setHiddenMarkerKinds((previous) => {
      const next = new Set(previous);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  // Bands ranked past the chart's cap. Plotted like any other, but hidden
  // until the legend switches them on, with `other` standing in for whichever
  // of them are still hidden — see `chartRollup`.
  const tailKeys = useMemo(() => labels.filter((series) => series.tail).map((series) => series.name), [labels]);

  // The keys the current pins produce. A hidden band must not survive a pin
  // change: under the next player the keys differ, and a set carried across
  // would hide an arbitrary band of a chart the user never touched. The reset
  // is to the TAIL rather than to nothing — that is the chart's resting state,
  // and the same reset that establishes it on first paint.
  //
  // Keyed on `seriesKeys` alone, deliberately: `tailKeys` is derived from the
  // same `labels`, so it is already the new chart's tail whenever the keys
  // change. Depending on it too would re-run the effect on every rebuild of
  // that array and throw away the user's legend clicks.
  const seriesKeys = useMemo(() => labels.map((series) => series.name).join(" "), [labels]);
  const tailKeysRef = useRef(tailKeys);
  tailKeysRef.current = tailKeys;
  useEffect(() => setHidden(new Set(tailKeysRef.current)), [seriesKeys]);

  // `other` is drawn only while something is inside it, and carries exactly
  // the tail bands still hidden — so switching one on moves it OUT of the
  // rollup rather than drawing it over a rollup that still contains it, and
  // the stack's height stays equal to the fight's own total throughout.
  const rollupDrawn = rollupIsDrawn(tailKeys, hidden);
  const plotData = useMemo(() => withRollupSeries(data, tailKeys, hidden), [data, tailKeys, hidden]);

  const shownSeries = useMemo(
    () =>
      labels.filter(
        (series) =>
          !hidden.has(series.name) &&
          // The rollup is drawn only while something is inside it. Hiding it
          // from the legend still works, and lowers the stack the same way
          // hiding any other band does.
          (series.name !== ROLLUP_SERIES_KEY || rollupDrawn)
      ),
    [labels, hidden, rollupDrawn]
  );

  const legendEntries = useMemo(
    () =>
      labels
        // The rollup explains itself through the tail entries beside it, and
        // hiding it would only leave the stack short of the fight.
        .filter((series) => series.name !== ROLLUP_SERIES_KEY || rollupDrawn)
        .map((series) => ({
          key: series.name,
          label: series.label ?? series.name,
          color: series.color,
          ...(series.tail === true ? { tail: true } : {}),
        })),
    [labels, rollupDrawn]
  );

  const toggleSeries = (key: string) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const maxIndex = Math.max(0, data.length - 1);
  const at = (index: number | undefined) => (typeof index === "number" ? index : null);

  const end = (last: number | null) => {
    const start = anchor.current;
    anchor.current = null;
    setBand(null);
    if (start === null || last === null) return;
    onScope(windowFromDrag(start, last, maxIndex));
  };

  // recharts' own drag, identical for both chart types — Mantine just forwards
  // it under a different prop name.
  const interaction = {
    margin: { top: 5, right: 5, bottom: 5, left: 5 },
    // Selecting text mid-drag would otherwise fight the gesture.
    style: { userSelect: "none" as const },
    onMouseDown: (state: { activeTooltipIndex?: number }) => {
      const index = at(state?.activeTooltipIndex);
      if (index === null) return;
      anchor.current = index;
      setBand([index, index]);
    },
    onMouseMove: (state: { activeTooltipIndex?: number }) => {
      if (anchor.current === null) return;
      const index = at(state?.activeTooltipIndex);
      if (index === null) return;
      setBand([anchor.current, index]);
    },
    onMouseUp: (state: { activeTooltipIndex?: number }) => end(at(state?.activeTooltipIndex)),
    // A drag that leaves the plot still has to end, or the next move over it
    // would extend a stale selection.
    onMouseLeave: () => {
      anchor.current = null;
      setBand(null);
    },
  };

  const shared = {
    // Grows with the view's density knob, like everything around it: at the
    // larger type the old ceiling left the plot shorter than the table's first
    // few rows.
    h: "clamp(calc(190px * var(--ui-scale)), 28vh, calc(380px * var(--ui-scale)))",
    // The rolled-up form, so the `other` band the legend offers has a series
    // to draw. Identical to `data` on a chart with no capped tail.
    data: plotData,
    dataKey: "timestamp",
    withDots: false,
    // Ours instead, rendered outside the plot: Mantine's is laid out INSIDE it
    // at a fixed 44px and overlaps it as soon as the entries wrap — see
    // ChartLegend.
    withLegend: false,
    series: shownSeries,
    valueFormatter: (value: number) => formatChartValue(format, value),
    // Wide enough for the tick text at the scaled-up font (`.analysis
    // .recharts-cartesian-axis-tick-value`) — recharts reserves this in pixels
    // and clips whatever overruns it.
    yAxisProps: { width: 72 },
    xAxisProps: { interval: "preserveStartEnd" as const },
  };

  // Kept out of `shared`: recharts types `content` against its own tooltip
  // props, and passing it through a plain object loses the contextual typing
  // that makes the destructured label and payload check.
  const tooltip = {
    content: (
      { label, payload }: { label?: unknown; payload?: Record<string, any>[] } // eslint-disable-line
    ) => (
      <ChartTooltip
        label={String(label ?? "")}
        payload={payload}
        format={format}
        labels={labels}
        sectionKey={sectionKey}
        markers={markersByLabel.get(String(label ?? ""))}
        windowLines={windowLinesByLabel.get(String(label ?? ""))}
        // A stacked plot draws its total as the stack's height but plots no
        // Total series — one would be added to the stack and double it — so
        // the card sums the bands to report the figure already on screen.
        // Overlapping areas ("normal") compose nothing, and sum to nothing.
        sumTotal={stacked && stackMode === "stacked"}
      />
    ),
  };

  // Status bands, drawn under the scope selection in the same chart space. A
  // band is milliseconds from the window's start and a bucket is one second
  // wide, so the index is the conversion — never a hand-written `/ 1000`.
  //
  // BOTH ends are clamped. An unclamped `x1` could index past the end of `data`
  // (a band starting in the window's last bucket), and recharts reads a missing
  // x1 as "the start of the axis" — a half-second buff then shaded the entire
  // chart. Floor the start and ceil the end so a band always covers the buckets
  // it touches rather than rounding off a short one to nothing.
  // Memoised: this mounts one element per span and the component re-renders on
  // every tooltip hover, which rebuilt and re-reconciled the whole set each time
  // the pointer moved across the plot.
  const statusBands = useMemo(() => {
    const bucket = (index: number) => Math.max(0, Math.min(maxIndex, index));
    // The battle-state windows draw FIRST (under the aura shading): both are
    // 16%-fill backdrops, and the aura mask is the active filter — it must
    // stay readable over whatever state happened to hold at the time.
    const spans = [...shownWindowBands, ...(bands ?? [])];
    return spans.map(({ color, band: span }, index) => (
      <ReferenceArea
        key={index}
        x1={data[bucket(Math.floor(span.startMs / DPS_BUCKET_MS))]?.timestamp}
        x2={data[bucket(Math.ceil(span.endMs / DPS_BUCKET_MS))]?.timestamp}
        stroke="none"
        fill={color}
        // Deeper stacks shade harder — this is the only place a stack count
        // reaches the chart, since the table has no Stacks column.
        fillOpacity={bandOpacity(span.stacks)}
      />
    ));
  }, [shownWindowBands, bands, data, maxIndex]);

  // Each shown marker paired with the x value of the bucket it lands in — the
  // same ms→bucket conversion the bands use, done once for the two consumers
  // below (the lines and the tooltip lookup), which would otherwise repeat the
  // clamp-and-convert and walk the markers twice for the same answer.
  const bucketedMarkers = useMemo(() => {
    const bucket = (index: number) => Math.max(0, Math.min(maxIndex, index));
    return shownMarkers.map((marker) => ({
      marker,
      timestamp: data[bucket(Math.floor(marker.atMs / DPS_BUCKET_MS))]?.timestamp,
    }));
  }, [shownMarkers, data, maxIndex]);

  // Marker lines, in the same chart space as the bands. Memoised for the same
  // hover-rerender reason.
  //
  // ONE line per kind per bucket. Co-located markers are the norm, not the edge
  // case: an SBA chain is `OnPerformSBA` plus up to three `OnContinueSBAChain`
  // within a second or two, so a full-party SBA drew four identical lines and
  // four ✦ glyphs on the same x, and two deaths in a bucket drew one line over
  // the other. The dedup is deliberately NOT applied to `markersByLabel` below
  // — the tooltip must still list every marker individually.
  const markerLines = useMemo(() => {
    const lines = new Map<string, { kind: MarkerKind; timestamp: string | undefined; color: string }>();
    for (const { marker, timestamp } of bucketedMarkers) {
      const key = `${marker.kind}@${timestamp}`;
      const drawn = lines.get(key);
      if (!drawn) lines.set(key, { kind: marker.kind, timestamp, color: marker.color });
      else if (drawn.color !== marker.color) drawn.color = MIXED_MARKER_COLOR;
    }
    return [...lines.values()].map(({ kind, timestamp, color }, index) => (
      <ReferenceLine
        key={`marker-${index}`}
        x={timestamp}
        stroke={color}
        strokeDasharray="3 3"
        // A number, not a token: recharts writes this into an SVG attribute and
        // a CSS var would not resolve there.
        label={{ value: MARKER_GLYPH[kind], position: "top", fill: color, fontSize: 12 }}
      />
    ));
  }, [bucketedMarkers]);

  // The markers of each bucket, keyed by that bucket's x label — which is what
  // the recharts tooltip hands its content, so the lookup is one map get.
  const markersByLabel = useMemo(() => {
    const byLabel = new Map<string, ChartMarker[]>();
    for (const { marker, timestamp } of bucketedMarkers) {
      if (timestamp === undefined) continue;
      const group = byLabel.get(timestamp);
      if (group) group.push(marker);
      else byLabel.set(timestamp, [marker]);
    }
    return byLabel;
  }, [bucketedMarkers]);

  // The window lines of each bucket, keyed by the bucket's x label like
  // markersByLabel — the tooltip's lookup is one map get. Hidden kinds drop
  // out here so shading and tooltip always agree on what is visible.
  const windowLinesByLabel = useMemo(() => {
    const byLabel = new Map<string, { kind: WindowKind; color: string; text: string }[]>();
    for (const entry of windowTooltips ?? []) {
      if (hiddenWindowKinds.has(entry.kind)) continue;
      const from = Math.max(0, Math.floor(entry.startMs / DPS_BUCKET_MS));
      const upTo = Math.min(maxIndex, Math.ceil(entry.endMs / DPS_BUCKET_MS) - 1);
      // The kind rides the line: the card heads each kind with its own name.
      const line = { kind: entry.kind, color: entry.color, text: entry.text };
      for (let bucket = from; bucket <= upTo; bucket += 1) {
        const label = data[bucket]?.timestamp;
        if (label === undefined) continue;
        const group = byLabel.get(label);
        if (group) group.push(line);
        else byLabel.set(label, [line]);
      }
    }
    return byLabel;
  }, [windowTooltips, hiddenWindowKinds, data, maxIndex]);

  const scopeBand = band && band[0] !== band[1] && (
    <ReferenceArea
      x1={data[Math.min(band[0], band[1])]?.timestamp}
      x2={data[Math.max(band[0], band[1])]?.timestamp}
      strokeOpacity={0.9}
      stroke="var(--color-accent)"
      fill="var(--color-accent)"
      fillOpacity={0.13}
    />
  );

  return (
    <Box style={{ padding: "10px 16px 8px" }}>
      <Box style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <UiLabel>{t(labelKey)}</UiLabel>
        <Group gap="sm">
          {onSmoothingChange !== undefined && smoothing !== undefined && (
            <PillGroup
              // The options are bare durations, so both the caption and the
              // aria-label are load-bearing: "Off 5s 10s 30s" on its own names
              // four values and no question, which is a control the reader can
              // operate without ever learning what it does. The title says what
              // choosing one MEANS.
              caption={t("ui.logs.chart-smoothing-caption")}
              ariaLabel={t("ui.logs.chart-smoothing-label")}
              title={t("ui.logs.chart-smoothing-hint")}
              value={String(smoothing)}
              onChange={(value) => onSmoothingChange(Number(value))}
              options={SMOOTHING_OPTIONS.map((buckets) => ({
                value: String(buckets),
                label:
                  buckets === 1
                    ? t("ui.logs.chart-smoothing-off")
                    : t("ui.logs.chart-smoothing-seconds", { seconds: buckets }),
              }))}
            />
          )}
          {onStackModeChange && (
            <PillGroup
              // "Normal" and "Stacked" name the options but not the choice, so
              // this pair carries a caption for the same reason the smoothing
              // window does.
              caption={t("ui.logs.chart-stack-caption")}
              ariaLabel={t("ui.logs.chart-stack-toggle-label")}
              title={t("ui.logs.chart-stack-hint")}
              value={stackMode}
              onChange={(value) => onStackModeChange(value as StackMode)}
              options={[
                { value: "normal", label: t("ui.logs.chart-stack-normal") },
                { value: "stacked", label: t("ui.logs.chart-stack-stacked") },
              ]}
            />
          )}
          {windowKinds.map((kind) => (
            <Checkbox
              key={`window-${kind}`}
              size="xs"
              // The band's own colour on the box, so the label names the hue
              // the plot shades with — identity never rides colour alone.
              color={WINDOW_BAND_COLOR[kind]}
              label={t(WINDOW_LABEL_KEY[kind])}
              checked={!hiddenWindowKinds.has(kind)}
              onChange={() => toggleWindowKind(kind)}
            />
          ))}
          {markerKinds.map((kind) => (
            <Checkbox
              key={kind}
              size="xs"
              label={t(MARKER_LABEL_KEY[kind])}
              checked={!hiddenMarkerKinds.has(kind)}
              onChange={() => toggleMarkerKind(kind)}
            />
          ))}
        </Group>
      </Box>
      {/* Double-click sits on the wrapper, not in `lineChartProps`: recharts'
          CategoricalChartProps has no onDoubleClick, and the wrapper sees the
          same gesture anywhere over the plot. */}
      <Box onDoubleClick={() => onScope(null)}>
        {stacked ? (
          // A thin stroke over a translucent fill: the band edges stay legible
          // where two bands are close, without the fills darkening into one mass.
          <AreaChart
            {...shared}
            // "default" overlaps the areas (WCL's Normal); "stacked" sums them.
            type={stackMode === "normal" ? "default" : "stacked"}
            strokeWidth={1}
            fillOpacity={0.3}
            areaChartProps={interaction}
            tooltipProps={tooltip}
          >
            {statusBands}
            {markerLines}
            {scopeBand}
          </AreaChart>
        ) : (
          <LineChart {...shared} lineChartProps={interaction} tooltipProps={tooltip}>
            {statusBands}
            {markerLines}
            {scopeBand}
          </LineChart>
        )}
      </Box>
      {/* The legend is the last thing under the plot. There used to be a row
          below it repeating the window's two ends and captioning the drag —
          the axis already prints both bounds under the plot, and a permanent
          instruction line is the kind of chrome that is read once and then
          costs a strip of the fight forever. The window itself is still stated,
          once, by the chip in PinBar. */}
      <ChartLegend entries={legendEntries} hidden={hidden} onToggle={toggleSeries} />
    </Box>
  );
};
