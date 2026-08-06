import { AreaChart, LineChart } from "@mantine/charts";
import { Box, Checkbox, Group, Paper, SegmentedControl, Text } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReferenceArea, ReferenceLine } from "recharts";

import { humanizeNumber } from "@/utils";

import { DPS_BUCKET_MS, type ChartDatapoint, type Label } from "../DetailCharts";
import { bandOpacity, type Band } from "../statusBands";

import { ChartLegend } from "./ChartLegend";
import "./analysis.css";
import type { ChartMarker, MarkerKind } from "./chartMarkers";
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

export type DpsChartProps = {
  /** Already sliced to the committed window, so the chart IS the window. */
  data: ChartDatapoint[];
  labels: Label;
  /** i18next key naming what is plotted; follows the metric tabs. */
  labelKey: string;
  /** How a value reads: a humanized amount, a gauge percentage, or a plain
   * integer count (a stack depth, which `humanizeNumbers` would render as
   * "3.0" and a percent sign would misdescribe). */
  format: "amount" | "percent" | "count";
  /** Commits a window as bucket indexes RELATIVE TO `data`, or null to clear. */
  onScope: (window: [number, number] | null) => void;
  /** Drawn under the plot as the axis bounds. */
  fromLabel: string;
  toLabel: string;
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
  markers,
  windowLines,
}: {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
  format: "amount" | "percent" | "count";
  /** The series descriptors, so a payload entry can be named. */
  labels: Label;
  /** Event markers that landed in THIS bucket, already named and coloured —
   * appended under the series rows, Warcraft Logs' behavior. */
  markers?: ChartMarker[];
  /** Battle-window lines covering THIS bucket, already coloured and worded —
   * appended under the marker rows. */
  windowLines?: { color: string; text: string }[];
}) => {
  if (!payload) return null;

  // Mantine hands recharts `name: item.name` — the series KEY, not its label
  // (AreaChart.mjs) — so the payload cannot name itself. Mantine's own legend
  // hides this by looking the key up through `getSeriesLabels`; ours has to do
  // the same, or it prints actor indexes and group keys at the user.
  const labelByKey = new Map(labels.map((series) => [series.name, series.label ?? series.name]));

  // Only what actually landed in this bucket, largest first. A stack of 17
  // skill-group bands is mostly zeroes at any one moment, and listing every one
  // of them buries the few that fired. The payload arrives in SERIES order,
  // which ranks the whole fight — at any one second the biggest contributor is
  // rarely the first band. A zero reads the same on the gauge tab: "0%" says
  // nothing the absent row does not.
  const landed = payload
    .filter((item) => typeof item.value === "number" && item.value !== 0)
    .sort((a, b) => (b.value as number) - (a.value as number));

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
  const nothingToShow = landed.length === 0 && (markers?.length ?? 0) === 0 && (windowLines?.length ?? 0) === 0;
  return (
    <Paper
      data-testid="chart-tooltip"
      px="md"
      py="sm"
      withBorder
      shadow="md"
      radius="md"
      style={nothingToShow ? { visibility: "hidden" } : undefined}
    >
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {landed.map((item) => {
        return (
          // Keyed by dataKey (the actor index), not name: two players can
          // share a display label, and React drops the duplicate row.
          <Text key={String(item.dataKey)} fz="sm">
            <Text component="span" c={item.color as string}>
              {labelByKey.get(String(item.name)) ?? String(item.name)}
            </Text>
            : {formatChartValue(format, item.value as number)}
          </Text>
        );
      })}
      {(markers ?? []).map((marker, index) => (
        <Text key={`marker-${index}`} fz="sm" c={marker.color}>
          {marker.label}
        </Text>
      ))}
      {(windowLines ?? []).map((line, index) => (
        <Text key={`window-${index}`} fz="sm" c={line.color}>
          {line.text}
        </Text>
      ))}
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
  format,
  onScope,
  fromLabel,
  toLabel,
  stacked = false,
  bands,
  windowBands,
  windowTooltips,
  markers,
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

  // The keys the current pins produce. A hidden band must not survive a pin
  // change: under the next player the keys differ, and a set carried across
  // would hide an arbitrary band of a chart the user never touched.
  const seriesKeys = useMemo(() => labels.map((series) => series.name).join(" "), [labels]);
  useEffect(() => setHidden(new Set()), [seriesKeys]);

  const shownSeries = useMemo(() => labels.filter((series) => !hidden.has(series.name)), [labels, hidden]);

  const legendEntries = useMemo(
    () => labels.map((series) => ({ key: series.name, label: series.label ?? series.name, color: series.color })),
    [labels]
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
    h: "clamp(190px, 26vh, 380px)",
    data,
    dataKey: "timestamp",
    withDots: false,
    // Ours instead, rendered outside the plot: Mantine's is laid out INSIDE it
    // at a fixed 44px and overlaps it as soon as the entries wrap — see
    // ChartLegend.
    withLegend: false,
    series: shownSeries,
    valueFormatter: (value: number) => formatChartValue(format, value),
    yAxisProps: { width: 60 },
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
        markers={markersByLabel.get(String(label ?? ""))}
        windowLines={windowLinesByLabel.get(String(label ?? ""))}
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
        label={{ value: MARKER_GLYPH[kind], position: "top", fill: color, fontSize: 10 }}
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
    const byLabel = new Map<string, { color: string; text: string }[]>();
    for (const entry of windowTooltips ?? []) {
      if (hiddenWindowKinds.has(entry.kind)) continue;
      const from = Math.max(0, Math.floor(entry.startMs / DPS_BUCKET_MS));
      const upTo = Math.min(maxIndex, Math.ceil(entry.endMs / DPS_BUCKET_MS) - 1);
      const line = { color: entry.color, text: entry.text };
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
      stroke="var(--an-accent)"
      fill="var(--an-accent)"
      fillOpacity={0.13}
    />
  );

  return (
    <Box style={{ padding: "10px 16px 8px" }}>
      <Box style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <Text className="analysis-label">{t(labelKey)}</Text>
        <Group gap="sm">
          {onStackModeChange && (
            <SegmentedControl
              size="xs"
              // "Normal" and "Stacked" name the options but not the choice, so
              // the radiogroup announces nothing about WHAT is being set — the
              // same reason View.tsx labels its own SegmentedControl.
              aria-label={t("ui.logs.chart-stack-toggle-label")}
              value={stackMode}
              onChange={(value) => onStackModeChange(value as StackMode)}
              data={[
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
      <ChartLegend entries={legendEntries} hidden={hidden} onToggle={toggleSeries} />
      <Box style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        <Text className="analysis-label">{fromLabel}</Text>
        <Text className="analysis-label">{t("ui.logs.chart-drag-hint")}</Text>
        <Text className="analysis-label">{toLabel}</Text>
      </Box>
    </Box>
  );
};
