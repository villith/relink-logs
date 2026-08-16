import { Box } from "@mantine/core";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAnalysisPanesStore } from "@/stores/useAnalysisPanesStore";
import { EMPTY_ENCOUNTER_FACTS, encounterFromResponse } from "@/stores/useEncounterStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type { LogSummary, MeterFilters } from "@/types";
import { formatInPartyOrder } from "@/utils";

import { DPS_BUCKET_MS, bucketLabel } from "../DetailCharts";
import { EventsTab } from "../events/EventsTab";
import type { ActorSpace } from "../events/eventRows";
import { spawnSegmentAt } from "../events/eventTargets";
import type { Hostility } from "../metrics/types";
import { type SelectorPins } from "../selectorOptions";
import { TimelineTab } from "../timeline/TimelineTab";

import { AuraStrip } from "./AuraStrip";
import { CollapseSupplementaryToggle } from "./CollapseSupplementaryToggle";
import { DebugBar } from "./DebugBar";
import { DpsChart, type EndLine, type StackMode } from "./DpsChart";
import { LogPicker } from "./LogPicker";
import { MetricTable } from "./MetricTable";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { RegroupStrip } from "./RegroupStrip";
import { WindowStrip } from "./WindowStrip";
import { EVENTS_TAB, TABLE_TAB, TIMELINE_TAB, bodyFor } from "./analysisTabs";
import type { MarkerKind } from "./chartMarkers";
import type { WindowKind } from "./chartWindowBands";
import { selectedChartWindows, windowFilterScrubRange } from "./chartWindowFilter";
import { paneTotals } from "./compareSeries";
import { buildDebugReadout } from "./debugReadout";
import { CAPABILITIES, levelFor } from "./machine/capabilities";
import { resolveViewSpec } from "./machine/resolve";
import type { AnalysisState } from "./machine/state";
import {
  toggleAura as auraTransition,
  clearPin,
  clearWindowFilters,
  pinRow,
  pinValueOf,
  regroup,
  scrubWindow,
  toggleWindowFilter as windowFilterTransition,
  toggleWindowKind as windowKindTransition,
  setWindow as windowTransition,
} from "./machine/transitions";
import { useActionLog } from "./machine/useActionLog";
import { useAnalysisState } from "./machine/useAnalysisState";
import { useAutoDrill } from "./machine/useAutoDrill";
import type { RowPresentation, StreamContext } from "./model/bodyContext";
import { useActorIdentity } from "./model/useActorIdentity";
import { useChartModel } from "./model/useChartModel";
import { useEncounterData } from "./model/useEncounterData";
import { useEntityCells } from "./model/useEntityCells";
import { useChartWindow, useFilterChips } from "./model/useFilterWindows";
import { useRowModel } from "./model/useRowModel";
import { useSelectorModel } from "./model/useSelectorModel";
import { useStatusNaming } from "./model/useStatusNaming";
import { useUrlQueryString } from "./useUrlQueryString";

/** The chart controls every pane's plot shares, owned by the frame.
 *
 * One of each for the whole view: two logs compared under different smoothing
 * windows, or one stacked against one overlapped, are two different readings
 * and not a comparison. The frame holds the state and resets it per metric; the
 * pane reads all of them from HERE — only `rateSmoothing` reaches the chart
 * model, the rest go straight to `DpsChart`, which is controlled by them. */
export type ChartControls = {
  stackMode: StackMode;
  setStackMode: (mode: StackMode) => void;
  /** The trailing smoothing window in buckets. */
  rateSmoothing: number;
  setRateSmoothing: (buckets: number) => void;
  /** Which marker and battle-window KINDS are switched off. Shared for the same
   * reason the two above are: the split layout draws the same fight twice, and
   * one plot hiding Break windows while the other shows them is not one
   * reading. */
  hiddenMarkerKinds: ReadonlySet<MarkerKind>;
  toggleMarkerKind: (kind: MarkerKind) => void;
  hiddenWindowKinds: ReadonlySet<WindowKind>;
  toggleWindowKind: (kind: WindowKind) => void;
};

export type AnalysisPaneProps = {
  /** Which pane this is, which is also which URL keys its state reads and
   * writes (see `paneParamName`). Fixed for the life of the component: the
   * frame keys panes by index so a reindex remounts rather than re-subscribing
   * a live pane's `useQueryState` calls to different names mid-render. */
  paneIndex: number;
  logId: number;
  filters: MeterFilters;
  /** Whether this pane draws its OWN plot. False while the frame overlays every
   * pane on one, where a per-pane chart would be the same data drawn twice. */
  drawsChart: boolean;
  /** The chart controls every pane's plot shares — one smoothing window and one
   * stack mode for the whole view, owned by the frame (see `ChartControls`). */
  chartControls: ChartControls;
  /** The pickable log library, for this pane's title (see `LogPicker`). Loaded
   * once by the frame and handed down rather than fetched per pane. */
  logs: LogSummary[];
  /** Opens a different log in THIS pane. */
  onChangeLog: (logId: number) => void;
  /** Where EVERY pane's fight ended, in buckets, so this plot can mark the runs
   * that stopped before its own (see `endLines`). This pane's own entry is
   * included and `visibleEndLines` drops it — its bucket is this chart's last
   * one by construction — so which rules exist has one author. Empty with one
   * log open. */
  paneEnds: EndLine[];
};

/** ONE log, end to end: its own fetches, its own pins, its own body.
 *
 * Extracted from `AnalysisView` as a move, not a rewrite — every comment here
 * carries reasoning that was paid for once already. The frame above it holds
 * only what is shared between panes. */
export const AnalysisPane = ({
  paneIndex,
  logId,
  filters,
  drawsChart,
  chartControls,
  logs,
  onChangeLog,
  paneEnds,
}: AnalysisPaneProps) => {
  // The id the fetches and the debug surfaces use. A string because that is what
  // `useParams` handed the view before panes existed, and both consumers parse
  // it back with `Number(...)`.
  const id = String(logId);
  // The pins live in the URL, so this string is the view's whole selection
  // state — read here only for the dev-only readout below the plot.
  const search = useUrlQueryString();

  // THIS pane's loaded log. A slice per pane rather than the single encounter
  // store the view used to read: two panes hold two different fights, and one
  // store can hold one. Normalised through the same function that store uses,
  // so an optional field absent from an older backend — and the party-slot
  // alignment findings ride on — cannot mean two things in two places.
  const base = useAnalysisPanesStore((panes) => panes.panes[paneIndex]?.base ?? null);
  const loaded = useMemo(() => (base === null ? EMPTY_ENCOUNTER_FACTS : encounterFromResponse(base)), [base]);
  const {
    encounterState: encounter,
    dpsChart,
    stunChart,
    takenChart,
    chartLen,
    sbaChart,
    sbaChartLen,
    sbaEvents,
    deathEvents,
    chartWindows,
    targetEntries,
    selectionFacts: baseFacts,
    groups: baseGroups,
    groupReference: baseGroupReference,
    statusIntervals,
    players: playerData,
    roomIndex,
    imported,
  } = loaded;

  const {
    show_display_names,
    streamer_mode,
    player_label_template,
    color_1,
    color_2,
    color_3,
    color_4,
    // Whether echo damage rides the skill that caused it. A stored setting
    // rather than the `supp` URL param it used to be: how someone reads damage
    // is a preference that should outlive the log they set it on, and the param
    // put it back to off on every log they opened.
    collapseSupplementary,
    // Whether the damage table carries WP%/BA% and its rows explain them. Off
    // by default — the rates are only as good as what the hook measured per
    // hit, and on most rows they read as a dash.
    showDamageFacts,
  } = useMeterSettingsStore(
    useShallow((state) => ({
      show_display_names: state.show_display_names,
      streamer_mode: state.streamer_mode,
      player_label_template: state.player_label_template,
      color_1: state.color_1,
      color_2: state.color_2,
      color_3: state.color_3,
      color_4: state.color_4,
      collapseSupplementary: state.merge_supplementary,
      showDamageFacts: state.show_damage_facts,
    }))
  );
  const setSettings = useMeterSettingsStore((state) => state.set);

  // The machine: the URL holds the WHOLE state (metric, side, pins, window,
  // grouping override), the resolver turns it into everything the view shows.
  const [state, setState] = useAnalysisState(paneIndex);
  // Which BODY this pane draws — the top-level view switch, which the FRAME
  // operates because there is one of it for the whole view. Its own nuqs key
  // rather than a machine field: neither Events nor Timeline is a metric, so
  // putting either in `AnalysisState` would mean a `MetricKey` the resolver has
  // no spec for. nuqs writes per key, so this and `useAnalysisState` share the
  // URL without either clobbering the other — and the pins therefore survive
  // switching between the three bodies, which is the whole point of sharing the
  // selector bar.
  const [tab] = useQueryState("tab", { history: "replace" });
  const body = bodyFor(tab);
  const caps = CAPABILITIES[state.metric];
  // The setting rides in because it decides the table's HEADER list — the cells
  // that fill it are gated on the same flag in `groupRowsFor`, so the two can
  // only move together.
  const spec = useMemo(() => resolveViewSpec(state, caps, showDamageFacts), [state, caps, showDamageFacts]);

  const metricKey = state.metric;
  // Effective hostility — the resolver's own rule: `side=enemy` is reachable
  // in the URL on any metric, and one that has no enemy side reads friendly.
  const hostility: Hostility = caps.supportsHostility ? state.hostility : "friendly";
  // Committed window as [start, end] second indexes; null = the full fight. The
  // in-flight drag lives inside DpsChart — nothing outside it needs to know
  // about a selection that has not been released yet.
  const range = state.window;
  // The legacy pin shape the pre-machine derivations still consume; dies with
  // them (plan 14d). `targets` carries at most the machine's ONE target.
  const pins: SelectorPins = useMemo(
    () => ({
      source: state.source,
      targets: state.target === null ? [] : [state.target],
      ability: state.ability,
    }),
    [state.source, state.target, state.ability]
  );
  // The legacy row level is a projection of the resolved grouping.
  const level = levelFor(spec.groupBy);
  // The chart window, both filter masks and the chip strips that operate them
  // (see `useFilterWindows`). Declared HERE, above the fetch memos, because the
  // masks ride the queries: `wireQuery` and the scoped fetch both read
  // `maskWindows`, and the uptime denominators read `fightDurationMs`.
  const { statusWindow, fightDurationMs, windowedIntervals, maskWindows, maskedIntervals, auraStackPercent } =
    useChartWindow({
      state,
      range,
      chartLen,
      bucketMs: DPS_BUCKET_MS,
      statusIntervals,
      chartWindows,
      hostility,
      fetchAuras: spec.fetch?.aura ?? [],
    });

  // Both fetches, their generation guards and every request-identity key (see
  // `useEncounterData`). Extracted whole: the response-ordering rules and the
  // scoped fetch's early-out are the most delicate reasoning in this view, and
  // they are one concern rather than part of the frame.
  const {
    groups,
    groupReference,
    chartGroupBy,
    scopedAbilitySeries,
    shownEncounter,
    facts,
    everySkill,
    rowKeying,
    pinnedActions,
  } = useEncounterData({
    id,
    filters,
    paneIndex,
    encounter,
    baseFacts,
    baseGroups,
    baseGroupReference,
    targetEntries,
    pins,
    spec,
    caps,
    window: state.window,
    range,
    maskWindows,
    collapseSupplementary,
    metricKey,
    bucketMs: DPS_BUCKET_MS,
  });

  // Figures for the current pins and window.
  const players = useMemo(() => (shownEncounter ? formatInPartyOrder(shownEncounter.party) : []), [shownEncounter]);

  // Every name, picture and colour an actor wears, in one bundle (see
  // `useActorIdentity`). Extracted from this file because the chart's bands,
  // the table's rows, the selectors' options, the hover cards and the events
  // stream all resolve through these — a second spelling of any one of them is
  // how one actor comes to be named two ways in two places.
  const identity = useActorIdentity({
    encounter,
    shownEncounter,
    targetEntries,
    playerData,
    sourcePin: pins.source,
    settings: { show_display_names, streamer_mode, player_label_template, color_1, color_2, color_3, color_4 },
  });
  // The view itself needs only these three; everything else travels as the
  // whole `identity` bundle into the model hooks below.
  const { identityPlayers, playerByIndex, enemyTypeAt, breakEnemyOf } = identity;

  // How an effect is named, and how its provenance is classed — both through
  // ONE cause ladder (see `useStatusNaming`). The view used to spell that
  // ladder out twice, which is how a row could be named "Guardpoint" and still
  // file under Unknown.
  const { statusDisplayLabel, classOfRow: classOfRowKey } = useStatusNaming({ statusIntervals, playerByIndex });

  // ONE set of entity lookups for the whole view (see `useEntityCells`). Every
  // body below resolves a name, an icon and a colour through this bundle, so a
  // player, a spawn, an ability or an effect cannot be named one way in the
  // table, drawn another way in the chart, and left uncoloured in a dropdown.
  // Declared here because it needs both halves — the identity party above and
  // the status namer beside it.
  const cells = useEntityCells({ identity, statusDisplayLabel, sourcePin: state.source });

  // The pick lists and the event stream's cells — both resolved through the
  // SAME namers and art the table's rows use (see `useSelectorModel`). A
  // second spelling of any of them here would let a dropdown and the row it
  // pins name one actor two different ways.
  const { eventPins, eventLabels, eventProbes, labelledOptions } = useSelectorModel({
    facts,
    pins,
    pinnedActions,
    targetEntries,
    identity,
    cells,
    playerLabelTemplate: player_label_template,
  });

  // The filter UI itself. Declared HERE rather than beside the masks above,
  // because a chip is LABELLED — `statusDisplayLabel` and `breakEnemyOf` both
  // need the party the fetch returns, while the masks have to be resolved
  // before that fetch is sent.
  const { sourceAuraChips, targetAuraChips, windowFilterGroups } = useFilterChips({
    state,
    hostility,
    supportsAuraFilter: caps.supportsAuraFilter,
    windowedIntervals,
    fightDurationMs,
    chartWindows,
    statusDisplayLabel,
    breakEnemyOf,
  });

  // The metric's rows and everything drawn about them: labels, art, colours,
  // provenance sections and hover cards. See `useRowModel`.
  const {
    metric,
    shownRows,
    rowChildren,
    rowName,
    rowArt,
    renderLabel,
    rowColor,
    rowSections,
    sectionLabelOf,
    isStatusMetric,
    effectLevel,
    tableKind,
  } = useRowModel({
    metricKey,
    caps,
    spec,
    level,
    hostility,
    pins,
    players,
    identityPlayers,
    targetEntries,
    playerData,
    groups,
    maskedIntervals,
    statusWindow,
    fightDurationMs,
    rowKeying,
    showDamageFacts,
    shownEncounter,
    sourcePin: state.source,
    identity,
    cells,
    classOfRowKey,
  });

  // The drill's last step, taken for the user: a pin that leaves the table with
  // ONE row pins that row too (see `useAutoDrill`). Armed by the pin handlers
  // below rather than standing over the rows, so the pin it applies stays
  // clearable.
  //
  // `settled` is what keeps it off the rows folded between a regroup and its
  // response — the groups path draws the PREVIOUS grouping's aggregates until
  // its own arrive (see `answeredGroups`), and one of those is not this drill's
  // answer. The other two data paths build their rows synchronously from the
  // pins, so their rows always answer the grouping in hand.
  const { armDrill } = useAutoDrill({
    rows: shownRows,
    state,
    setState,
    settled: caps.dataPath !== "groups" || chartGroupBy === spec.groupBy,
    enabled: body === TABLE_TAB,
  });

  // Bound once against the spawn table rather than inline in the timeline's
  // props: it is in that body's lane memo's dependencies, and a fresh arrow
  // each render re-folds the whole event stream on every unrelated change.
  const segmentAt = useCallback(
    (index: number, atMs: number, space: ActorSpace) => spawnSegmentAt(targetEntries, index, atMs, space),
    [targetEntries]
  );

  // A row click pins its dimension through the machine's transition, so the
  // `by` override drops and the derived default advances — WCL's behavior.
  // The payload still arrives in the legacy `SelectorPins` wire shape, read by
  // the same `pinValueOf` the auto-drill rule reads a row's payload with.
  const handlePin = useCallback(
    (next: Partial<SelectorPins>) => {
      const pin = pinValueOf(next);
      if (pin === null) return;
      armDrill();
      setState(pinRow(state, pin));
    },
    [state, setState, armDrill]
  );

  // The selector bar hands back whole pin sets. A change per dimension routes
  // through the same transitions a row click uses: an addition pins (and
  // advances the default), a removal only clears its own dimension.
  //
  // An addition arms the auto-drill for the same reason a row click does — it
  // IS a drill, only spelled through a dropdown. A removal deliberately does
  // not: re-drilling what was just cleared is how the ✕ would undo itself.
  const handlePinsChange = useCallback(
    (next: SelectorPins) => {
      const target = next.targets.length > 0 ? next.targets[0] : null;
      let draft = state;
      let pinned = false;
      if (next.source !== state.source) {
        draft = next.source === null ? clearPin(draft, "source") : pinRow(draft, { dim: "source", value: next.source });
        pinned = pinned || next.source !== null;
      }
      if (target !== state.target) {
        draft = target === null ? clearPin(draft, "target") : pinRow(draft, { dim: "target", value: target });
        pinned = pinned || target !== null;
      }
      if (next.ability !== state.ability) {
        draft =
          next.ability === null ? clearPin(draft, "ability") : pinRow(draft, { dim: "ability", value: next.ability });
        pinned = pinned || next.ability !== null;
      }
      if (draft === state) return;
      if (pinned) armDrill();
      setState(draft);
    },
    [state, setState, armDrill]
  );

  // Everything the plot is: which of the five series builders won, how that
  // reads (title, axis format, smoothing), the points themselves, the legend,
  // the markers and the shaded bands. See `useChartModel`.
  const {
    shownChartData,
    labels,
    labelKey,
    format,
    stacked,
    smoothing,
    chartSource,
    chartMarkers,
    maskBands,
    stateWindowBands,
    chartWindowTooltips,
  } = useChartModel({
    rateSmoothing: chartControls.rateSmoothing,
    caps,
    spec,
    metricKey,
    hostility,
    pins,
    range,
    chartLen,
    bucketMs: DPS_BUCKET_MS,
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
    playerLabelTemplate: player_label_template,
  });

  // This pane's source universe, its pin and the handler that moves it,
  // published for the FRAME's shared actor bar — one selector per log, so a
  // comparison picks one source from each (see `PaneSources`).
  //
  // The HANDLER travels rather than the frame writing the pin itself: pinning a
  // source is `pinRow` plus arming the auto-drill, and a frame that spelled that
  // out again would be a second author of the rule a row click already follows.
  // Wrapped through a ref so the published function's identity never changes —
  // publishing a fresh closure on every render would write the store on every
  // render, re-render the frame, and re-render this pane.
  const sourceChangeRef = useRef(handlePinsChange);
  sourceChangeRef.current = handlePinsChange;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const onSourceChange = useCallback((next: number | null) => {
    sourceChangeRef.current({ ...pinsRef.current, source: next });
  }, []);

  const setPaneSources = useAnalysisPanesStore((panes) => panes.setPaneSources);
  const paneSources = useMemo(
    () => ({ options: labelledOptions.sources, value: pins.source, onChange: onSourceChange }),
    [labelledOptions.sources, pins.source, onSourceChange]
  );
  useEffect(() => {
    setPaneSources(paneIndex, paneSources);
  }, [paneIndex, paneSources, setPaneSources]);

  // What this pane's plot comes to per bucket, published for the frame's
  // compare overlay. Resolved HERE because deciding what a plot totals is the
  // chart model's job, and there is one of those per pane; the frame only draws
  // the lines side by side.
  const setPaneChart = useAnalysisPanesStore((panes) => panes.setPaneChart);
  const paneChart = useMemo(
    () => ({ totals: paneTotals(shownChartData, labels), format }),
    [shownChartData, labels, format]
  );
  useEffect(() => {
    setPaneChart(paneIndex, paneChart);
  }, [paneIndex, paneChart, setPaneChart]);

  // The dev-only readout: the state, what the machine resolved it INTO, and the
  // stored settings that colour the reading. Built even in a release build —
  // it is a handful of string joins, and gating it would mean gating the memo
  // and every value feeding it, which is more machinery than the strings cost.
  const debugReadout = useMemo(
    () =>
      buildDebugReadout({
        state,
        spec,
        caps,
        body,
        // The rows answer the CURRENT grouping only once the fetch that asked
        // for it has landed; the same test `useAutoDrill` gates itself on.
        settled: caps.dataPath !== "groups" || chartGroupBy === spec.groupBy,
        chartFormat: format,
        smoothing,
        merge: collapseSupplementary,
        streamer: streamer_mode,
        displayNames: show_display_names,
        rows: shownRows.length,
        mask: maskWindows,
        windows: chartWindows,
      }),
    [
      state,
      spec,
      caps,
      body,
      chartGroupBy,
      format,
      smoothing,
      collapseSupplementary,
      streamer_mode,
      show_display_names,
      shownRows,
      maskWindows,
      chartWindows,
    ]
  );

  // What the user DID to get here, this mount. Recorded from the URL state
  // rather than from the controls: every pin, metric, side, regroup, zoom and
  // filter lands there, so one watcher covers the lot.
  const actions = useActionLog(state, tab);

  // A window-filter change, with the chart's zoom brought along: the scrub
  // commits to the bucket hull of everything the NEW selection admits.
  //
  // An emptied selection returns the whole fight, which is what clearing the
  // last chip should do. A selection that still holds values but resolves to no
  // windows (every index went stale against a reparsed log) leaves the scrub
  // alone rather than zooming to nothing.
  const withWindowScrub = useCallback(
    (next: AnalysisState): AnalysisState => {
      if (next.win.length === 0) return windowTransition(next, null);
      const scrub = windowFilterScrubRange(selectedChartWindows(chartWindows, next.win), DPS_BUCKET_MS);
      return scrub === null ? next : windowTransition(next, scrub);
    },
    [chartWindows]
  );

  // A drag on this pane's plot, committed through the same rule the frame's
  // compare overlay commits its own drags with (see `scrubWindow`).
  const handleScope = useCallback(
    (next: [number, number] | null) => setState(scrubWindow(state, next)),
    [state, setState]
  );

  // The two contexts the three bodies share. Built once rather than threaded
  // prop by prop: Table and Timeline must draw one row identically, and Events
  // and Timeline must read one stream identically — handing each its own copy
  // of the resolvers is exactly how they would come to differ.
  const stream: StreamContext = { id, metric: metricKey, hostility, pins: eventPins, probes: eventProbes };
  const presentation: RowPresentation = {
    rows: shownRows,
    rowKind: tableKind,
    rowName,
    rowArt,
    renderLabel,
    rowColor,
    onPin: handlePin,
    rowSections,
    cardAmount: metric.card,
    ...(effectLevel ? { sectionLabel: sectionLabelOf } : {}),
    // The resolver names the honest empty states (see `emptyKeyFor`). The aura
    // tabs' key means "this log never recorded status events", so it applies
    // only when the fight truly has no intervals — with intervals in hand an
    // empty status table IS about the pins, and the body's own default says so.
    ...(isStatusMetric && statusIntervals.length > 0 ? {} : { emptyKey: spec.table.emptyKey }),
  };

  /** The pane's TITLE is its log picker: the thing that names which log this
   * column is about is the same thing that changes it, so there is no separate
   * header naming a log you then go elsewhere to swap. The quest name, the
   * party, the date, the two clocks and the id all live inside the control (see
   * `LogPicker`), which is why the summary beside it carries only what the
   * picker does not. */
  const header = (
    <QuestSummary
      roomIndex={roomIndex}
      imported={imported}
      title={<LogPicker logs={logs} value={Number.isFinite(logId) ? logId : null} onChange={onChangeLog} />}
    />
  );

  // Nothing loaded yet — or a log whose fetch failed. The HEADER still draws:
  // as the whole page this returning null read as "loading", but as one column
  // of a comparison a bare 1fr track has no title, no picker and no way back,
  // so a pane pointed at a deleted or unreadable log could only be closed. The
  // picker is also what the user reaches for to try another log.
  if (!shownEncounter) return header;

  const windowLabel = range === null ? null : `${bucketLabel(range[0])} – ${bucketLabel(range[1])}`;
  const fullLabel = bucketLabel(Math.max(0, chartLen - 1));

  return (
    <>
      {header}

      {/* The other two pins narrow whatever is below them. Below the metric tabs
          rather than above: the enemies and abilities they offer are the ones
          the CURRENT metric's facts turned up. */}
      <PinBar
        options={labelledOptions}
        pins={pins}
        onChange={handlePinsChange}
        windowLabel={windowLabel}
        fullLabel={fullLabel}
        onClearWindow={() => setState(windowTransition(state, null))}
      />

      {/* Everything from here down to the body is the metric's own frame, and
          it is the SAME frame in both views — a plot of the metric, the filters
          over it, and then either its figures or its events. Only that last
          block swaps. */}
      {/* WCL's "Done By …" strip: the resolved grouping is only a default,
          and this is the override (`by` in the URL). */}
      <RegroupStrip tabs={spec.regroupTabs} onRegroup={(dim) => setState(regroup(state, dim, caps))} />

      {/* Withheld while the frame overlays every pane on one plot: the same
          data drawn twice, once per pane and once above them, is two answers to
          one question and twice the height to scroll past. */}
      {drawsChart && (
        <DpsChart
          data={shownChartData}
          labels={labels}
          labelKey={labelKey}
          // The table's own row-label key: the plot's series and the table's
          // rows are one set of things, so the tooltip's breakdown heads itself
          // with the same word the column below it does.
          sectionKey={spec.table.rowsLabelKey}
          format={format}
          stacked={stacked}
          onScope={handleScope}
          markers={chartMarkers}
          // The marker and window switches are the VIEW's, not this plot's, so
          // two split charts of one comparison cannot end up hiding different
          // kinds (see `ChartControls`).
          hiddenMarkerKinds={chartControls.hiddenMarkerKinds}
          onToggleMarkerKind={chartControls.toggleMarkerKind}
          hiddenWindowKinds={chartControls.hiddenWindowKinds}
          onToggleWindowKind={chartControls.toggleWindowKind}
          // Where the log in the OTHER pane ran out. Split, the two plots share
          // no axis, so without this the shorter run just stops and reads as a
          // fight that went quiet.
          endLines={paneEnds}
          bands={maskBands}
          windowBands={stateWindowBands}
          windowTooltips={chartWindowTooltips}
          smoothing={smoothing}
          // Offered on RATE charts only. On a level (the undrilled SBA gauge,
          // the aura stacks) `chartPresentation` pins smoothing to 1 whatever is
          // chosen, so a control there would be a knob that does nothing.
          onSmoothingChange={format === "amount" ? chartControls.setRateSmoothing : undefined}
          stackMode={chartSource === "stacks" ? chartControls.stackMode : undefined}
          onStackModeChange={chartSource === "stacks" ? chartControls.setStackMode : undefined}
          // In the chart's own control strip, beside the smoothing window: it
          // belongs with the other knobs that change how the fight READS, not
          // with the side switch, which changes WHOSE fight is being read. It
          // folds the table as well as the plot, so it rides the strip as a
          // caller-supplied control rather than as something the chart owns.
          //
          // Disabled rather than hidden, for the same reason HostilityToggle is:
          // only Damage Done records supplementary damage, and a control that
          // came and went with the tab would shift the whole strip each time.
          controls={
            <CollapseSupplementaryToggle
              value={collapseSupplementary}
              onChange={(next) => setSettings({ merge_supplementary: next })}
              disabled={!caps.recordsSupplementary}
            />
          }
        />
      )}

      {/* Dev builds only, the same guard the Debug tab uses. */}
      {import.meta.env.DEV && <DebugBar search={search} readout={debugReadout} actions={actions} />}

      {/* The Windows strip: the battle-window filter's UI, on every tab —
          unlike the aura strips it needs no pin to anchor it. Changing the
          selection also COMMITS the scrub window to the SELECTION'S bucket
          hull — the chart zooms to it through the same mechanism a drag uses,
          so the readout, the uptime denominators and the fetches all follow.
          Emptying the selection clears that zoom with it; a selection that
          resolves to no windows (every index stale) leaves the scrub alone.

          Computed off the state the transition RETURNS rather than off the
          value the strip reported: with several windows selectable the hull
          spans all of them, and the clicked one is only the newest. */}
      <WindowStrip
        groups={windowFilterGroups}
        onToggleWindow={(win) => setState(withWindowScrub(windowFilterTransition(state, win)))}
        onToggleKind={(kind) => setState(withWindowScrub(windowKindTransition(state, kind)))}
        onClear={() => setState(windowTransition(clearWindowFilters(state), null))}
      />

      {/* The Auras Filter (spec: between chart and table). Each strip exists
          only while its actor pin does — AuraStrip renders nothing for an
          empty chip list — and both select into ONE list whose entries all
          apply at once, by intersection. */}
      {caps.supportsAuraFilter && (
        <>
          <AuraStrip
            titleKey="ui.logs.aura-source-title"
            chips={sourceAuraChips}
            onToggle={(aura) => setState(auraTransition(state, aura))}
            stacked={auraStackPercent !== null}
            stackPercent={auraStackPercent}
          />
          <AuraStrip
            titleKey="ui.logs.aura-target-title"
            chips={targetAuraChips}
            onToggle={(aura) => setState(auraTransition(state, aura))}
            stacked={auraStackPercent !== null}
            stackPercent={auraStackPercent}
          />
        </>
      )}

      {/* The ONE block the view switch swaps: the metric's figures, the same
          rows drawn against time, or the raw events behind them. Everything
          above is the same in all three. */}
      {body === EVENTS_TAB ? (
        <EventsTab stream={stream} labels={eventLabels} playerData={playerData} />
      ) : body === TIMELINE_TAB ? (
        <TimelineTab
          stream={stream}
          presentation={presentation}
          everySkill={everySkill}
          keying={rowKeying}
          window={statusWindow}
          segmentAt={segmentAt}
          enemyTypeAt={enemyTypeAt}
          // The stream's own ability resolver, which already dispatches an
          // effect key away from the ability join (see `abilityOptionCell`) —
          // re-testing the prefix here would be the same split spelled twice,
          // with two branches that resolve to one function.
          markEntry={eventLabels.ability}
        />
      ) : (
        <Box style={{ padding: "4px 16px 14px" }}>
          <MetricTable
            {...presentation}
            // The SOURCE header rides the same `effectLevel` condition that
            // prepends the cells, so the two can never disagree — deliberately
            // NOT declared on the descriptor's columnKeys: a `by` regroup can
            // move groupBy without moving the rows off the effect level, and
            // the PIN (not the grouping) is what statusRows keys the level on.
            columnKeys={effectLevel ? ["ui.logs.buff-source", ...spec.table.columnKeys] : spec.table.columnKeys}
            rowChildren={rowChildren}
            timelineMs={fightDurationMs}
            rowsLabelKey={spec.table.rowsLabelKey}
          />
        </Box>
      )}
    </>
  );
};
