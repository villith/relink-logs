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

import { ActorBar } from "./ActorBar";
import { AuraStrip } from "./AuraStrip";
import { CollapseSupplementaryToggle } from "./CollapseSupplementaryToggle";
import { DebugBar } from "./DebugBar";
import { DpsChart, type EndLine, type StackMode } from "./DpsChart";
import { LogPicker } from "./LogPicker";
import { MetricTable } from "./MetricTable";
import { PaneLoading } from "./PaneLoading";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { RegroupStrip } from "./RegroupStrip";
import { WindowStrip } from "./WindowStrip";
import { EVENTS_TAB, TABLE_TAB, TIMELINE_TAB, bodyFor } from "./analysisTabs";
import type { MarkerKind } from "./chartMarkers";
import type { WindowKind } from "./chartWindowBands";
import { selectedChartWindows, windowFilterScrubRange } from "./chartWindowFilter";
import { paneTotals } from "./compareSeries";
import type { PaneWindows } from "./compareWindows";
import { buildDebugReadout } from "./debugReadout";
import { CAPABILITIES, levelFor } from "./machine/capabilities";
import { LINKED_DIMS, applyPinChange, pinChangesOf, splitPinChanges } from "./machine/linkedPins";
import { resolveViewSpec } from "./machine/resolve";
import type { AnalysisState } from "./machine/state";
import {
  clearWindowFilters,
  pinRow,
  pinValueOf,
  regroup,
  scrubWindow,
  setAura,
  toggleWindowFilter as windowFilterTransition,
  toggleWindowKind as windowKindTransition,
  setWindow as windowTransition,
  type PinValue,
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
import { useHeldContent } from "./useHeldContent";
import { useUrlQueryString } from "./useUrlQueryString";

const SHOW_DEBUG_BAR: boolean = false;

export type ChartControls = {
  stackMode: StackMode;
  setStackMode: (mode: StackMode) => void;
  rateSmoothing: number;
  setRateSmoothing: (buckets: number) => void;
  hiddenMarkerKinds: ReadonlySet<MarkerKind>;
  toggleMarkerKind: (kind: MarkerKind) => void;
  hiddenWindowKinds: ReadonlySet<WindowKind>;
  toggleWindowKind: (kind: WindowKind) => void;
};

export type AnalysisPaneProps = {
  paneIndex: number;
  logId: number;
  filters: MeterFilters;
  drawsChart: boolean;
  chartControls: ChartControls;
  logs: LogSummary[];
  onChangeLog: (logId: number) => void;
  seriesColor?: string;
  paneEnds: EndLine[];
  /** Applies one transition to EVERY pane at once — the frame's shared write
   * (`sharedControlWrites`), the same machinery the metric tabs and the side
   * toggle go through.
   *
   * Handed in ONLY while the comparison draws one chart, and it is the presence
   * of it that decides: a target, an ability or an aura picked here then selects
   * the same thing in every other pane (see `LINKED_DIMS`). Absent — one log
   * open, or a split comparison where each pane has a plot of its own — every
   * write below is this pane's alone, exactly as before. */
  linkedWrite?: (transition: (state: AnalysisState) => AnalysisState) => void;
};

export const AnalysisPane = ({
  paneIndex,
  logId,
  filters,
  drawsChart,
  chartControls,
  logs,
  onChangeLog,
  seriesColor,
  paneEnds,
  linkedWrite,
}: AnalysisPaneProps) => {
  const id = String(logId);
  const search = useUrlQueryString();
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
    collapseSupplementary,
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

  const [state, setState] = useAnalysisState(paneIndex);
  const [tab] = useQueryState("tab", { history: "replace" });
  const body = bodyFor(tab);
  const caps = CAPABILITIES[state.metric];
  const spec = useMemo(() => resolveViewSpec(state, caps, showDamageFacts), [state, caps, showDamageFacts]);

  const metricKey = state.metric;
  const hostility: Hostility = caps.supportsHostility ? state.hostility : "friendly";
  const range = state.window;
  const pins: SelectorPins = useMemo(
    () => ({
      source: state.source,
      targets: state.target === null ? [] : [state.target],
      ability: state.ability,
    }),
    [state.source, state.target, state.ability]
  );
  const level = levelFor(spec.groupBy);
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

  const {
    groups,
    groupReference,
    chartGroupBy,
    groupsSettled: aggregatesAnswerTheRequest,
    scopedAbilitySeries,
    shownEncounter,
    facts,
    everySkill,
    rowKeying,
    pinnedActions,
    pending,
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

  const players = useMemo(() => (shownEncounter ? formatInPartyOrder(shownEncounter.party) : []), [shownEncounter]);
  const identity = useActorIdentity({
    encounter,
    shownEncounter,
    targetEntries,
    playerData,
    sourcePin: pins.source,
    settings: { show_display_names, streamer_mode, player_label_template, color_1, color_2, color_3, color_4 },
  });
  const { identityPlayers, playerByIndex, enemyTypeAt, breakEnemyOf } = identity;
  const { statusDisplayLabel, classOfRow: classOfRowKey } = useStatusNaming({ statusIntervals, playerByIndex });

  const cells = useEntityCells({ identity, statusDisplayLabel, sourcePin: state.source });
  const { eventPins, eventLabels, eventProbes, labelledOptions } = useSelectorModel({
    facts,
    pins,
    hostility,
    pinnedActions,
    targetEntries,
    identity,
    cells,
    playerLabelTemplate: player_label_template,
  });

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

  // One author for "apply this pin": whether it stays with this log or reaches
  // every pane is decided here and nowhere else, so a row click, a selector and
  // the auto-drill that follows either of them cannot come to disagree.
  const applyPin = useCallback(
    (pin: PinValue) => {
      if (linkedWrite !== undefined && LINKED_DIMS.has(pin.dim)) linkedWrite((draft) => pinRow(draft, pin));
      else setState(pinRow(state, pin));
    },
    [linkedWrite, setState, state]
  );

  const groupsSettled = caps.dataPath !== "groups" || aggregatesAnswerTheRequest;
  const { armDrill } = useAutoDrill({
    rows: shownRows,
    state,
    setState,
    settled: groupsSettled,
    enabled: body === TABLE_TAB,
    applyPin,
  });

  const segmentAt = useCallback(
    (index: number, atMs: number, space: ActorSpace) => spawnSegmentAt(targetEntries, index, atMs, space),
    [targetEntries]
  );

  const handlePin = useCallback(
    (next: Partial<SelectorPins>) => {
      const pin = pinValueOf(next);
      if (pin === null) return;
      armDrill();
      applyPin(pin);
    },
    [applyPin, armDrill]
  );

  const handlePinsChange = useCallback(
    (next: SelectorPins) => {
      const changes = pinChangesOf(state, next);
      if (changes.length === 0) return;
      if (changes.some((change) => change.value !== null)) armDrill();

      const { own, shared } = splitPinChanges(changes, linkedWrite !== undefined);
      if (own.length > 0) setState(own.reduce(applyPinChange, state));
      if (shared.length > 0 && linkedWrite !== undefined) {
        linkedWrite((draft) => shared.reduce(applyPinChange, draft));
      }
    },
    [state, setState, armDrill, linkedWrite]
  );

  // The aura filter, set ABSOLUTELY rather than toggled once it travels: two
  // panes that disagree about an effect would flip apart under one toggle, so
  // the strip the user clicked in decides what selected now means.
  const handleAura = useCallback(
    (aura: string) => {
      const selected = !state.aura.includes(aura);
      if (linkedWrite === undefined) {
        setState(setAura(state, aura, selected));
        return;
      }
      linkedWrite((draft) => setAura(draft, aura, selected));
    },
    [state, setState, linkedWrite]
  );

  const {
    shownChartData,
    labels,
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

  const setPaneChart = useAnalysisPanesStore((panes) => panes.setPaneChart);
  const paneChart = useMemo(
    () => ({ totals: paneTotals(shownChartData, labels), format }),
    [shownChartData, labels, format]
  );
  useEffect(() => {
    setPaneChart(paneIndex, paneChart);
  }, [paneIndex, paneChart, setPaneChart]);

  // Published whether or not this pane draws a chart: the frame's overlay has no
  // fight of its own to read the battle-state windows from, and a pane that only
  // published them while drawing would have nothing to hand over exactly when
  // the overlay is the one plot on screen.
  const setPaneWindows = useAnalysisPanesStore((panes) => panes.setPaneWindows);
  const paneWindows: PaneWindows = useMemo(
    () => ({ bands: stateWindowBands, tooltips: chartWindowTooltips }),
    [stateWindowBands, chartWindowTooltips]
  );
  useEffect(() => {
    setPaneWindows(paneIndex, paneWindows);
  }, [paneIndex, paneWindows, setPaneWindows]);

  const setPaneMarkers = useAnalysisPanesStore((panes) => panes.setPaneMarkers);
  useEffect(() => {
    setPaneMarkers(paneIndex, chartMarkers);
  }, [paneIndex, chartMarkers, setPaneMarkers]);

  const debugReadout = useMemo(
    () =>
      buildDebugReadout({
        state,
        spec,
        caps,
        body,
        settled: groupsSettled,
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
      groupsSettled,
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

  const actions = useActionLog(state, tab);

  const withWindowScrub = useCallback(
    (next: AnalysisState): AnalysisState => {
      if (next.win.length === 0) return windowTransition(next, null);
      const scrub = windowFilterScrubRange(selectedChartWindows(chartWindows, next.win), DPS_BUCKET_MS);
      return scrub === null ? next : windowTransition(next, scrub);
    },
    [chartWindows]
  );

  const handleScope = useCallback(
    (next: [number, number] | null) => setState(scrubWindow(state, next)),
    [state, setState]
  );

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
    ...(isStatusMetric && statusIntervals.length > 0 ? {} : { emptyKey: spec.table.emptyKey }),
  };

  const header = (
    <>
      <QuestSummary
        roomIndex={roomIndex}
        imported={imported}
        title={
          <LogPicker
            logs={logs}
            value={Number.isFinite(logId) ? logId : null}
            onChange={onChangeLog}
            color={seriesColor}
          />
        }
      />

      <ActorBar panes={[paneSources]} hostility={hostility} />
    </>
  );

  const windowLabel = range === null ? null : `${bucketLabel(range[0])} – ${bucketLabel(range[1])}`;
  const fullLabel = bucketLabel(Math.max(0, chartLen - 1));

  const paneBody = !shownEncounter ? null : (
    <>
      <PinBar
        options={labelledOptions}
        pins={pins}
        onChange={handlePinsChange}
        hostility={hostility}
        windowLabel={windowLabel}
        fullLabel={fullLabel}
        onClearWindow={() => setState(windowTransition(state, null))}
      />

      <RegroupStrip tabs={spec.regroupTabs} onRegroup={(dim) => setState(regroup(state, dim, caps))} />

      {drawsChart && (
        <DpsChart
          data={shownChartData}
          labels={labels}
          sectionKey={spec.table.rowsLabelKey}
          format={format}
          stacked={stacked}
          onScope={handleScope}
          markers={chartMarkers}
          hiddenMarkerKinds={chartControls.hiddenMarkerKinds}
          onToggleMarkerKind={chartControls.toggleMarkerKind}
          hiddenWindowKinds={chartControls.hiddenWindowKinds}
          onToggleWindowKind={chartControls.toggleWindowKind}
          endLines={paneEnds}
          bands={maskBands}
          windowBands={stateWindowBands}
          windowTooltips={chartWindowTooltips}
          smoothing={smoothing}
          onSmoothingChange={format === "amount" ? chartControls.setRateSmoothing : undefined}
          stackMode={chartSource === "stacks" ? chartControls.stackMode : undefined}
          onStackModeChange={chartSource === "stacks" ? chartControls.setStackMode : undefined}
          controls={
            <CollapseSupplementaryToggle
              value={collapseSupplementary}
              onChange={(next) => setSettings({ merge_supplementary: next })}
              disabled={!caps.recordsSupplementary}
            />
          }
        />
      )}

      {SHOW_DEBUG_BAR && import.meta.env.DEV && <DebugBar search={search} readout={debugReadout} actions={actions} />}

      <WindowStrip
        groups={windowFilterGroups}
        onToggleWindow={(win) => setState(withWindowScrub(windowFilterTransition(state, win)))}
        onToggleKind={(kind) => setState(withWindowScrub(windowKindTransition(state, kind)))}
        onClear={() => setState(windowTransition(clearWindowFilters(state), null))}
      />

      {caps.supportsAuraFilter && (
        <>
          <AuraStrip
            titleKey="ui.logs.aura-source-title"
            chips={sourceAuraChips}
            onToggle={handleAura}
            stacked={auraStackPercent !== null}
            stackPercent={auraStackPercent}
          />
          <AuraStrip
            titleKey="ui.logs.aura-target-title"
            chips={targetAuraChips}
            onToggle={handleAura}
            stacked={auraStackPercent !== null}
            stackPercent={auraStackPercent}
          />
        </>
      )}

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
          markEntry={eventLabels.ability}
        />
      ) : (
        <Box style={{ padding: "4px 16px 14px" }}>
          <MetricTable
            {...presentation}
            columnKeys={effectLevel ? ["ui.logs.buff-source", ...spec.table.columnKeys] : spec.table.columnKeys}
            rowChildren={rowChildren}
            timelineMs={fightDurationMs}
            rowsLabelKey={spec.table.rowsLabelKey}
          />
        </Box>
      )}
    </>
  );

  const holding = !groupsSettled;
  const shownBody = useHeldContent(paneBody, paneBody !== null && holding);

  return (
    <>
      {header}

      <Box className={`analysis-pane-body${shownBody === null ? " analysis-pane-body-empty" : ""}`}>
        <PaneLoading pending={pending || holding} />
        <Box className={holding ? "analysis-pane-held" : undefined} aria-hidden={holding || undefined}>
          {shownBody}
        </Box>
      </Box>
    </>
  );
};
