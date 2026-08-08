import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AbilitySeries,
  ChartWindow,
  DeathEvent,
  GroupAggregate,
  GroupReference,
  SBAEvent,
  StatusInterval,
} from "@/types";
import { PLAYER_COLORS, humanizeNumber, millisecondsToElapsedFormat, translateCharacterType } from "@/utils";

import { DPS_SMOOTHING_WINDOW, type ChartDatapoint, type Label } from "../../DetailCharts";
import type { RowKeying } from "../../abilitySkills";
import { keyColor } from "../../actorColor";
import { enemyHolderKey, heldByRoster, narrowedByPins, slotsOf } from "../../metrics/buffs";
import type { Hostility } from "../../metrics/types";
import { playerRowKey } from "../../rowKey";
import type { SelectorPins } from "../../selectorOptions";
import type { Band } from "../../statusBands";
import type { StackMode } from "../DpsChart";
import { abilityBands } from "../abilityBands";
import { auraExcludedBands } from "../auraWindows";
import { bandColorAt, paletteOrderOf, referenceBandOrder } from "../bandPalette";
import { chartPlayerIndexes } from "../chartIndexes";
import { SBA_MARKER_COLOR, extractMarkers, type ChartMarker, type MarkerKind } from "../chartMarkers";
import { chartPresentation } from "../chartPresentation";
import { ROLLUP_SERIES_KEY } from "../chartRollup";
import { TOTAL_SERIES_KEY, buildSeriesPoints, withTotalSeries } from "../chartSeries";
import { WINDOW_BAND_COLOR, windowBandsFor } from "../chartWindowBands";
import { admittedBucketsOf } from "../chartWindowFilter";
import { windowMetricAmount, windowTooltipEntries } from "../chartWindowTooltip";
import { legendLabelFor } from "../legendLabel";
import { levelFor, type MetricCapabilities } from "../machine/capabilities";
import { groupBandsFor } from "../machine/groupRows";
import { GROUP_TOP_N, type ViewSpec } from "../machine/resolve";
import type { MetricKey } from "../machine/state";
import { buildStatusSeries } from "../statusChart";
import type { WireWindow } from "../wireWindows";

import type { ActorIdentity } from "./useActorIdentity";
import type { EntityCells } from "./useEntityCells";

/** Tooltip line per marker kind. Sibling of `DpsChart`'s `MARKER_LABEL_KEY`, but
 * a separate key set: those name the control-row checkboxes, these are the
 * strings the tooltip lists under a marker line. */
const MARKER_LINE_KEY: Record<MarkerKind, string> = {
  death: "ui.logs.chart-marker-death-line",
  sba: "ui.logs.chart-marker-sba-line",
};

/** A `Label`'s optional `icon` field, present only where there is art. The
 * type is `icon?: string` under `exactOptionalPropertyTypes`, so writing
 * `icon: undefined` is a type error rather than an omission. */
const iconField = (icon: string | undefined) => (icon === undefined ? {} : { icon });

export type ChartModel = {
  shownChartData: ChartDatapoint[];
  labels: Label;
  labelKey: string;
  format: "amount" | "percent" | "count";
  stacked: boolean;
  smoothing: number;
  chartSource: "base" | "scoped" | "stacks" | "drill" | "ability";
  stackMode: StackMode;
  setStackMode: (mode: StackMode) => void;
  setRateSmoothing: (buckets: number) => void;
  chartMarkers: ChartMarker[];
  maskBands: { color: string; band: Band }[] | undefined;
  stateWindowBands: ReturnType<typeof windowBandsFor>;
  chartWindowTooltips: ReturnType<typeof windowTooltipEntries>;
};

export type ChartModelInput = {
  /** The log being viewed — the stack mode resets per log as well as per
   * metric, because a mode chosen for one fight says nothing about the next. */
  id: string | undefined;
  caps: MetricCapabilities;
  spec: ViewSpec;
  metricKey: MetricKey;
  hostility: Hostility;
  pins: SelectorPins;
  range: [number, number] | null;
  chartLen: number;
  bucketMs: number;
  dpsChart: Record<number, number[]>;
  stunChart: Record<number, number[]>;
  takenChart: Record<number, number[]>;
  sbaChart: Record<number, number[]>;
  sbaChartLen: number;
  deathEvents: DeathEvent[];
  sbaEvents: SBAEvent[];
  chartWindows: ChartWindow[];
  statusWindow: { startMs: number; endMs: number };
  statusIntervals: StatusInterval[];
  maskWindows: WireWindow[] | undefined;
  groups: GroupAggregate[];
  /** The whole-fight ranking the bands take their COLOURS from. Empty for the
   * derived tabs and whenever nothing narrows time — both cases already rank by
   * the whole fight, so the drawn order is its own reference. */
  groupReference: GroupReference[];
  chartGroupBy: ViewSpec["groupBy"];
  scopedAbilitySeries: Record<number, AbilitySeries[]>;
  rowKeying: RowKeying;
  /** Whether this metric's rows are status effects — passed rather than
   * re-derived, so the chart and the table agree about which tab this is. */
  isStatusMetric: boolean;
  identity: ActorIdentity;
  /** The view's one set of entity lookups — the same bundle the table and the
   * selectors resolve through, so a band and its row cannot disagree. */
  cells: EntityCells;
  playerLabelTemplate: string;
};

export const useChartModel = ({
  id,
  caps,
  spec,
  metricKey,
  hostility,
  pins,
  range,
  chartLen,
  bucketMs,
  dpsChart,
  stunChart,
  takenChart,
  sbaChart,
  sbaChartLen,
  deathEvents,
  sbaEvents,
  chartWindows,
  statusWindow,
  statusIntervals,
  maskWindows,
  groups,
  groupReference,
  chartGroupBy,
  scopedAbilitySeries,
  rowKeying,
  isStatusMetric,
  identity,
  cells,
  playerLabelTemplate,
}: ChartModelInput): ChartModel => {
  const { t, i18n } = useTranslation();
  const {
    identityPlayers,
    playerByIndex,
    colors,
    colorContext,
    labelForSource,
    labelForTarget,
    playerColor,
    breakEnemyOf,
  } = identity;
  const { cellOf } = cells;
  const groupsPath = caps.dataPath === "groups";
  const level = levelFor(chartGroupBy);
  /** Bucket index → "M:SS", for the plotted points' timestamps. */
  const bucketLabel = useCallback((bucket: number) => millisecondsToElapsedFormat(bucket * bucketMs), [bucketMs]);
  // Normal | Stacked for the stacks chart. Component-local: a way of reading
  // the plot, not what the page is about. Reset per metric/log because a mode
  // chosen for one chart says nothing about the next one.
  const [stackMode, setStackMode] = useState<StackMode>("normal");
  // The chart's smoothing window, in buckets. Feeds `chartPresentation` as
  // `rateSmoothing` rather than overriding its result, so the rate-vs-level rule
  // still decides: a LEVEL chart stays unsmoothed whatever is chosen here.
  const [rateSmoothing, setRateSmoothing] = useState<number>(DPS_SMOOTHING_WINDOW);
  useEffect(() => setStackMode("normal"), [metricKey, id]);

  // Death and SBA markers, rebased onto the same window the chart shows and
  // resolved to display form here — the extractor stays pure of names and
  // colours. Deaths wear the dead player's party colour; SBA lines wear
  // `SBA_MARKER_COLOR`, which is picked to collide with no party colour.
  // Unknown actors (enemy deaths) are dropped by the extractor itself.
  // Battle-state windows (SBA performances, Link Time, enemy Breaks), clipped
  // and rebased onto the same window the markers and mask bands use.
  const stateWindowBands = useMemo(() => windowBandsFor(chartWindows, statusWindow), [chartWindows, statusWindow]);

  const chartMarkers: ChartMarker[] = useMemo(() => {
    const knownActors = new Set(playerByIndex.keys());
    return extractMarkers({ deathEvents, sbaEvents, window: statusWindow, knownActors }).map((event) => ({
      kind: event.kind,
      atMs: event.atMs,
      color:
        event.kind === "death"
          ? // The `?? 0` cannot fire here, unlike the other `resolvePlayerColor`
            // call sites: `knownActors` is `playerByIndex`'s own key set, so the
            // extractor only ever returns markers this map can resolve. It stays
            // because the optional chain still types as `number | undefined` — no
            // marker is silently coloured as party slot 0.
            playerColor(event.actorIndex, 0)
          : SBA_MARKER_COLOR,
      label: t(MARKER_LINE_KEY[event.kind], { name: labelForSource(event.actorIndex) }),
    }));
  }, [deathEvents, sbaEvents, playerColor, statusWindow, playerByIndex, labelForSource, t]);

  // What the plot shows follows the metric's OWN declaration (see `ChartDecl`).
  // Each metric brings its own bucketed series from the base load, so switching
  // tabs never refetches. Declared rather than branched on here: adding a
  // metric with its own plot is adding a declaration, not editing this view.
  const chartMetric = useMemo(() => {
    const decl = caps.chart;
    const source =
      decl.series === "stun"
        ? stunChart
        : decl.series === "taken"
          ? takenChart
          : decl.series === "sba"
            ? sbaChart
            : dpsChart;
    return {
      labelKey: decl.labelKey,
      source,
      // The SBA gauge is captured on its own cadence, so it carries its own
      // length; everything else rides the shared bucket count.
      len: decl.series === "sba" ? sbaChartLen : chartLen,
      // A rate takes the shared trailing average; a level takes none at all.
      smoothing: decl.smoothing === "rate" ? DPS_SMOOTHING_WINDOW : 1,
      scale: decl.scale,
      format: decl.format,
    };
  }, [caps.chart, dpsChart, stunChart, takenChart, chartLen, sbaChart, sbaChartLen]);

  // A band's name and its art, off the ONE entity ladder the table's rows and
  // the selectors' options resolve through (see `useEntityCells`). A band and
  // the row it decomposes are the same thing seen twice, so they cannot read
  // differently — and a band can never wear one entity's name over another's
  // picture, because both come out of a single branch.
  const bandLabelFor = useCallback((key: string): string => cellOf(key).name, [cellOf]);
  const bandIcon = useCallback((key: string): string | undefined => cellOf(key).iconUrl, [cellOf]);

  // The groups path's source grouping on the friendly side is the per-player
  // chart the base load used to own — one LINE per player in party colours,
  // not a stacked overlay — narrowed by whatever the query filtered, which is
  // exactly what the old scoped per-player rebuild provided.
  const groupPlayerSeries = useMemo(() => {
    if (!groupsPath || chartGroupBy !== "source" || hostility !== "friendly") return null;
    const byIndex: Record<number, number[]> = {};
    for (const aggregate of groups) {
      if (aggregate.key.kind === "player") byIndex[aggregate.key.index] = aggregate.series;
    }
    return Object.keys(byIndex).length > 0 ? byIndex : null;
  }, [groupsPath, chartGroupBy, hostility, groups]);

  // Every other grouping (and the whole enemy side) stacks the aggregates'
  // bands — the same series whose sums the table's rows report, so the chart
  // and the table cannot disagree.
  const groupOverlay = useMemo(() => {
    if (!groupsPath || (chartGroupBy === "source" && hostility === "friendly")) return null;
    if (groups.length === 0) return null;
    // The same cap the query asked for: the backend keeps every row for the
    // table and appends one `other` band summing the tail, so the chart has to
    // slice or it stacks that tail twice.
    // Through the view's own keying, the same one the rows fold by: a band and
    // the row it decomposes are one thing, so an echo cannot ride its cause in
    // the table while standing as its own band in the plot above it.
    return groupBandsFor(groups, GROUP_TOP_N, rowKeying).map(({ key, values, tail }) => ({
      key,
      label: bandLabelFor(key),
      values,
      ...(tail === true ? { tail: true } : {}),
    }));
  }, [groupsPath, chartGroupBy, hostility, groups, bandLabelFor, rowKeying]);

  // The Stacks plot: one series per holder of the pinned effect, each its own
  // stack count. The Normal | Stacked control decides whether they overlap or
  // sum — Normal by default — so the height reads as one holder's depth or as
  // the party's total accordingly. Only on the status tabs, and only with an
  // effect pinned — an effect row spans every holder and has no single series
  // to draw.
  //
  // `statusIntervals`, not `windowedIntervals`: the chart is cropped by the
  // parent (`shownChartData`), so cropping again here would shorten the series
  // against a chart that is already the window.
  const statusSeries = useMemo(() => {
    if (!isStatusMetric) return null;
    // Same roster split as the table (`statusTabRows`): an effect held on both
    // sides would otherwise grow one series mislabeled by the other side's key.
    const roster = slotsOf(identityPlayers);
    const series = buildStatusSeries({
      // The same narrowing the table applies (`narrowedByPins`): a pinned
      // holder shows that holder's stack curve alone — the holder×effect
      // drill's chart half.
      intervals: narrowedByPins(heldByRoster(statusIntervals, roster, hostility === "friendly"), pins, hostility),
      pinnedKey: pins.ability,
      bucketMs: bucketMs,
      len: chartLen,
      holderOf: (interval) =>
        hostility === "enemy"
          ? {
              key: enemyHolderKey(interval),
              label:
                interval.targetSegment === null ? String(interval.actorIndex) : labelForTarget(interval.targetSegment),
            }
          : { key: playerRowKey(interval.actorIndex), label: labelForSource(interval.actorIndex) },
    });
    return series.length > 0 ? series : null;
  }, [isStatusMetric, statusIntervals, pins, chartLen, hostility, labelForTarget, labelForSource, identityPlayers]);

  // The drilled Stun/SBA plot: the backend's per-breakdown-row bands folded into
  // the table's ability rows (see `abilityBands` — the parser cannot produce
  // those keys, so the fold happens here with the same function the table uses).
  //
  // Only the derived tabs reach this: everything else either has no `ability`
  // grouping or gets its bands from the group query.
  const abilitySeries = useMemo(() => {
    // `caps.dataPath`, not just the grouping: `scoped` survives a metric switch
    // until the NEXT response lands, so going from Stun/ability to Damage/ability
    // would otherwise draw the previous tab's stun bands over the damage chart
    // for one render. Gated on the same condition `abilityQuery` requests under,
    // so the chart can only draw bands this tab actually asked for.
    if (caps.dataPath !== "derived" || spec.groupBy !== "ability") return null;
    const bands =
      pins.source === null ? Object.values(scopedAbilitySeries).flat() : scopedAbilitySeries[pins.source] ?? [];
    if (bands.length === 0) return null;
    // Same cap as the group bands — both feed the eight-colour palette. The
    // fold follows the table's: a PINNED group's rows are its members, so the
    // bands must be too, or the chart redraws the band that was just clicked.
    return abilityBands(bands, GROUP_TOP_N, bandLabelFor, pins.ability === null ? "group" : "action", rowKeying);
  }, [caps.dataPath, spec.groupBy, pins.source, pins.ability, scopedAbilitySeries, bandLabelFor, rowKeying]);

  // Which series the per-player chart draws — identityPlayers, not players,
  // so a pin cannot drop the curves the pinned one is compared against. See
  // `chartPlayerIndexes`, which owns the rule and the two cases where a pin
  // must NOT narrow.
  //
  // The aura tabs reach the narrowing branch now that nothing overlays them
  // until an effect is pinned: a pinned holder draws that holder's own damage
  // line, beside the table of what they held.
  const chartIndexes = useMemo(
    () =>
      chartPlayerIndexes({
        party: identityPlayers.map((player) => player.index),
        sourcePin: pins.source,
        hostility,
        overlaid: Boolean(statusSeries || groupOverlay || abilitySeries || groupPlayerSeries),
      }),
    [identityPlayers, statusSeries, groupOverlay, abilitySeries, groupPlayerSeries, pins.source, hostility]
  );

  // With no source pinned, an enemy or ability pin still narrows the fight, and
  // the backend rebuilds the per-player series under it — otherwise the plot
  // keeps drawing the whole fight beside a table that has halved. Damage only:
  // it is the only metric a target span can narrow honestly (see
  // `build_scoped_player_chart`).
  // Which series won, what that makes the plot, and how it is titled and
  // formatted — one pure fold of the series above (see chartPresentation.ts),
  // so the heading can never disagree with what is on screen.
  const { overlay, chartSource, withTotal, labelKey, format, stacked, smoothing } = chartPresentation({
    statusSeries,
    groupOverlay,
    abilitySeries,
    groupPlayerSeries,
    groupsPath,
    // The grouping the plotted aggregates ANSWER, not the one just requested —
    // so the Total series and the title change with the data rather than a
    // fetch ahead of it (see `answeredGroups`).
    groupBy: chartGroupBy,
    hostility,
    metricKey,
    level: level,
    metricLabelKey: chartMetric.labelKey,
    metricFormat: chartMetric.format,
    rateSmoothing,
  });

  // The chart's raw inputs — which series, from where, at what scale — shared
  // by the plotted data below and the window tooltip's amounts, so the
  // tooltip can never sum a different fight than the plot draws.
  const chartInputs = useMemo(() => {
    const source = overlay
      ? Object.fromEntries(overlay.map((series) => [series.key, series.values]))
      : groupPlayerSeries ?? chartMetric.source;
    const keys = overlay ? overlay.map((series) => series.key) : chartIndexes;
    // Group series are built over the whole fight from the same per-second
    // buckets, so their own length is authoritative — the base load's
    // chartLen belongs to a different fetch.
    const len = overlay
      ? Math.max(0, ...overlay.map((series) => series.values.length))
      : groupPlayerSeries
        ? Math.max(0, ...Object.values(groupPlayerSeries).map((values) => values.length))
        : chartMetric.len;
    // The group series are raw damage like `dpsChart`, so their scale is 1 on
    // the damage tab either way — kept explicit rather than accidental.
    const scale = overlay || groupPlayerSeries ? 1 : chartMetric.scale;
    return { source: source as Record<string, number[]>, keys, len, scale };
  }, [chartMetric, chartIndexes, overlay, groupPlayerSeries]);

  const chartData: ChartDatapoint[] = useMemo(() => {
    const points = buildSeriesPoints({
      source: chartInputs.source,
      len: chartInputs.len,
      keys: chartInputs.keys,
      // Decided with the rest of the presentation (see chartPresentation.ts):
      // rates smooth, levels do not, and which is which follows `format`.
      smoothing,
      scale: chartInputs.scale,
      // Rate charts only ("amount"): their series are masked to zeros outside
      // the admitted spans, and the trailing average would smear the last
      // in-window spike past the mask's edge — 10s of phantom damage after a
      // window filter's end. The levels (SBA gauge, stack counts) draw
      // UNmasked full-fight series where zeroing would misread as "the gauge
      // was empty", so they keep the shading-only treatment.
      ...(format === "amount" && maskWindows !== undefined
        ? { admitted: admittedBucketsOf(maskWindows, chartInputs.len, bucketMs) }
        : {}),
    });
    // Summed over ALL fetched series, not the legend-visible ones — the values
    // are baked into the data, so hiding a player later cannot lower the Total.
    return (withTotal ? withTotalSeries(points, chartInputs.keys) : points).map((point, bucket) => ({
      ...point,
      timestamp: bucketLabel(bucket),
    })) as ChartDatapoint[];
  }, [chartInputs, smoothing, withTotal, format, maskWindows]);

  // The hover payload for the shaded windows. Amounts only where the plot's Y
  // is a rate ("amount" format) — the SBA gauge and the stack charts plot a
  // LEVEL, and summing a level over buckets answers nothing.
  const chartWindowTooltips = useMemo(
    () =>
      windowTooltipEntries(
        chartWindows,
        statusWindow,
        (span) =>
          format === "amount"
            ? windowMetricAmount(chartInputs.source, chartInputs.keys, chartInputs.scale, span)
            : null,
        {
          color: (kind) => WINDOW_BAND_COLOR[kind],
          // The ROW's text, which no longer names its own kind: the card heads
          // each kind's rows with that name once (see `CardNotes`), and a line
          // repeating it under its own heading says the word twice. A Break
          // still leads with the enemy — that is what distinguishes two Breaks
          // of the same kind from each other.
          text: (span, amount) => {
            const enemy = span.kind === "break" ? breakEnemyOf(span.actorIndex, span) : null;
            const withAmount = amount !== null;
            return t(
              enemy === null
                ? withAmount
                  ? "ui.logs.chart-window-row-amount"
                  : "ui.logs.chart-window-row"
                : withAmount
                  ? "ui.logs.chart-window-row-of-amount"
                  : "ui.logs.chart-window-row-of",
              {
                enemy: enemy ?? "",
                range: `${millisecondsToElapsedFormat(span.startMs)}–${millisecondsToElapsedFormat(span.endMs)}`,
                duration: t("ui.logs.window-chip-duration", {
                  seconds: Math.round((span.endMs - span.startMs) / 1000),
                }),
                amount: amount === null ? "" : humanizeNumber(amount),
              }
            );
          },
        }
      ),
    // i18n.language: every label in the line is translated.
    [chartWindows, statusWindow, format, chartInputs, breakEnemyOf, t, i18n.language]
  );

  // The colour ordering: the backend's whole-fight totals folded onto the same
  // bands the plot draws, ranked, and used as the palette index. Empty
  // reference — the derived tabs, and any request that narrows no time — falls
  // through to the drawn order, which in both those cases IS the whole fight.
  const paletteOrder = useMemo(
    () => paletteOrderOf(referenceBandOrder(groupReference, rowKeying), overlay ? overlay.map((s) => s.key) : []),
    [groupReference, rowKeying, overlay]
  );

  const labels: Label = useMemo(
    () =>
      // Drilled in, the bands are one player's own output split up, so the
      // party palette says nothing about them — they take the categorical one
      // the enemy-HP chart already uses, in the same largest-first order.
      //
      // Resolved to a CSS var here rather than left as Mantine's "red.6"
      // shorthand: the same value reaches our own legend, which writes it
      // straight into `backgroundColor` (ChartLegend), where a shorthand is not
      // valid CSS and the swatch renders colourless. Mantine's `getThemeColor`
      // returns a non-theme string unchanged, so the plotted line is the same
      // colour either way — and this matches `statusRowColors`, which already
      // resolves the same palette for the table rows.
      overlay
        ? [
            ...overlay.map((series, position) => ({
              name: series.key,
              label: series.label,
              partySlotIndex: position,
              // Ranked past the band cap: drawn only once the legend switches
              // it on, with `other` below standing in for it until then.
              ...(series.tail === true ? { tail: true } : {}),
              // An ACTOR band takes its actor's own colour — the same one its row
              // in the table and its entry in the dropdown take, so one enemy is
              // one colour wherever it appears. Everything else — an ability
              // drill, a taken-attack row, the `other` remainder — takes the
              // categorical palette at its WHOLE-FIGHT rank, not its rank here:
              // ranking by the filtered order repainted the chart every time a
              // filter reordered it, which is the same fault `actorColor`
              // already refuses for enemies. `position` is the fallback for a
              // band no reference names, which is every band before one arrives.
              color: keyColor(series.key, colorContext) ?? bandColorAt(paletteOrder.get(series.key) ?? position),
              // Omitted rather than written undefined: most bands have art,
              // and the ones that do not stay text-only in the tooltip rather
              // than reserving a blank box (see `BreakdownEntry.icon`).
              ...iconField(bandIcon(series.key)),
            })),
            // LAST, so recharts stacks the remainder on top of the bands that
            // outrank it. Declared whenever a tail exists; the chart drops it
            // again once every tail band has been switched on and it stands
            // for nothing (see `chartRollup`).
            ...(overlay.some((series) => series.tail)
              ? [
                  {
                    name: ROLLUP_SERIES_KEY,
                    label: bandLabelFor(ROLLUP_SERIES_KEY),
                    partySlotIndex: -1,
                    color: "var(--mantine-color-gray-6)",
                  },
                ]
              : []),
          ]
        : [
            // First in the array so recharts draws it FIRST — the player lines
            // sit on top of the neutral dashed Total, never under it.
            ...(withTotal
              ? [
                  {
                    name: TOTAL_SERIES_KEY,
                    label: t("ui.logs.chart-total-label"),
                    partySlotIndex: -1,
                    color: "var(--mantine-color-gray-5)",
                    strokeDasharray: "6 4",
                  },
                ]
              : []),
            ...identityPlayers
              .filter((player) => chartIndexes.includes(player.index))
              .map((player) => ({
                name: String(player.index),
                // The legend carries no rank or position, so it names the
                // character too — otherwise two AI players are told apart by
                // colour alone.
                label: legendLabelFor(
                  labelForSource(player.index),
                  translateCharacterType(player.characterType),
                  playerLabelTemplate
                ),
                partySlotIndex: player.partyIndex,
                color: colors[player.partyIndex % colors.length] ?? PLAYER_COLORS[0],
                ...iconField(bandIcon(playerRowKey(player.index))),
              })),
          ],
    [
      overlay,
      identityPlayers,
      chartIndexes,
      labelForSource,
      colors,
      playerLabelTemplate,
      withTotal,
      t,
      colorContext,
      bandLabelFor,
      bandIcon,
      paletteOrder,
    ]
  );

  // The combined filter's EXCLUDED regions, shaded onto the plot in the
  // neutral ink so they read as "off" rather than as another effect. The band
  // mechanism inverted: the data drawn IS the kept part, so the shading marks
  // what the filter removed. Undefined rather than empty when nothing is
  // masked, so a chart with no aura or window filter renders exactly as it
  // did before.
  const maskBands = useMemo(() => {
    if (maskWindows === undefined) return undefined;
    const excluded = auraExcludedBands(maskWindows, statusWindow);
    return excluded.length === 0 ? undefined : excluded.map((band) => ({ color: "var(--color-ink-3)", band }));
  }, [maskWindows, statusWindow]);

  // The chart IS the window: committing does not shade the rest of the fight,
  // it stops drawing it. Sliced client-side from the base load — the reparse
  // that `range` triggers is for the table, which needs figures no bucketed
  // series can give.
  const shownChartData = useMemo(
    () => (range === null ? chartData : chartData.slice(range[0], range[1] + 1)),
    [chartData, range]
  );

  return {
    shownChartData,
    labels,
    labelKey,
    format,
    stacked,
    smoothing,
    chartSource,
    stackMode,
    setStackMode,
    setRateSmoothing,
    chartMarkers,
    maskBands,
    stateWindowBands,
    chartWindowTooltips,
  };
};
