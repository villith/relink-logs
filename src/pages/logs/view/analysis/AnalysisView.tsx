import { Box } from "@mantine/core";
import { useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { formatInPartyOrder, millisecondsToElapsedFormat } from "@/utils";

import { DPS_BUCKET_MS } from "../DetailCharts";
import { EventsTab } from "../events/EventsTab";
import type { ActorSpace } from "../events/eventRows";
import { spawnSegmentAt } from "../events/eventTargets";
import type { Hostility } from "../metrics/types";
import { type SelectorPins } from "../selectorOptions";
import { TimelineTab } from "../timeline/TimelineTab";

import { ActorBar } from "./ActorBar";
import { AnalysisTopBar } from "./AnalysisTopBar";
import { AuraStrip } from "./AuraStrip";
import { CollapseSupplementaryToggle } from "./CollapseSupplementaryToggle";
import { DebugBar } from "./DebugBar";
import { DpsChart } from "./DpsChart";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTable } from "./MetricTable";
import { MetricTabs, type MetricTab } from "./MetricTabs";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { RegroupStrip } from "./RegroupStrip";
import { WindowStrip } from "./WindowStrip";
import "./analysis.css";
import { selectedChartWindows, windowFilterScrubRange } from "./chartWindowFilter";
import { buildDebugReadout } from "./debugReadout";
import { CAPABILITIES, levelFor } from "./machine/capabilities";
import { resolveViewSpec } from "./machine/resolve";
import type { AnalysisState, MetricKey } from "./machine/state";
import {
  toggleAura as auraTransition,
  clearPin,
  clearWindowFilters,
  setHostility as hostilityTransition,
  setMetric as metricTransition,
  pinRow,
  pinValueOf,
  regroup,
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
import { METRICS, useRowModel } from "./model/useRowModel";
import { useSelectorModel } from "./model/useSelectorModel";
import { useStatusNaming } from "./model/useStatusNaming";
import { useUrlQueryString } from "./useUrlQueryString";

/** The switcher's contents, derived from `METRICS` — each descriptor already
 * carries the label the tab shows, and two lists that must agree is one list
 * too many. Insertion order above is the display order. */
const METRIC_TABS: MetricTab[] = Object.entries(METRICS).map(([value, descriptor]) => ({
  value,
  labelKey: descriptor.labelKey,
}));

/** The raw-event-stream view's value in the top-level switch, and in the `tab`
 * URL param. Its absence means the default view, the table. */
const EVENTS_TAB = "events";
/** The positional view: the metric's own rows drawn against fight time. */
const TIMELINE_TAB = "timeline";
/** The default view: the chart-and-table body, everything the metric tabs
 * switch between. Never written to the URL — a default in the URL is noise. */
const TABLE_TAB = "table";

/** The top-level switch, which changes the WHOLE body below the selector bar.
 *
 * Neither Events nor Timeline is a metric — they have no chart of their own, no
 * groupings and no numeric columns, so there is nothing for
 * `CAPABILITIES`/`resolveViewSpec` to answer for them. Both ride the `tab`
 * param instead of `state.metric`, so the pins survive switching between the
 * three bodies — which is the point of sharing the selector bar. */
const VIEW_TABS: MetricTab[] = [
  { value: TABLE_TAB, labelKey: "ui.logs.view-table-tab" },
  { value: TIMELINE_TAB, labelKey: "ui.logs.timeline-tab" },
  { value: EVENTS_TAB, labelKey: "ui.logs.events-tab" },
];

/** Bucket index → "M:SS", for the window readout. */
const bucketLabel = (bucket: number) => millisecondsToElapsedFormat(bucket * DPS_BUCKET_MS);

export const AnalysisView = () => {
  const { id } = useParams();
  // The pins live in the URL, so this string is the view's whole selection
  // state — read here only for the dev-only readout below the plot.
  const search = useUrlQueryString();
  const filters = useMeterFilters();

  const {
    encounter,
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
    playerData,
    questId,
    questTimer,
    questCompleted,
    roomIndex,
    imported,
    loadFromResponse,
  } = useEncounterStore(
    useShallow((state) => ({
      encounter: state.encounterState,
      dpsChart: state.dpsChart,
      stunChart: state.stunChart,
      takenChart: state.takenChart,
      chartLen: state.chartLen,
      sbaChart: state.sbaChart,
      sbaChartLen: state.sbaChartLen,
      sbaEvents: state.sbaEvents,
      deathEvents: state.deathEvents,
      chartWindows: state.chartWindows,
      targetEntries: state.targetEntries,
      selectionFacts: state.selectionFacts,
      groups: state.groups,
      groupReference: state.groupReference,
      statusIntervals: state.statusIntervals,
      playerData: state.players,
      questId: state.questId,
      questTimer: state.questTimer,
      questCompleted: state.questCompleted,
      roomIndex: state.roomIndex,
      imported: state.imported,
      loadFromResponse: state.loadFromResponse,
    }))
  );

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
    }))
  );
  const setSettings = useMeterSettingsStore((state) => state.set);

  // The machine: the URL holds the WHOLE state (metric, side, pins, window,
  // grouping override), the resolver turns it into everything the view shows.
  const [state, setState] = useAnalysisState(0);
  // Which BODY the frame shows — the top-level view switch. Its own nuqs key
  // rather than a machine field: neither Events nor Timeline is a metric, so
  // putting either in `AnalysisState` would mean a `MetricKey` the resolver has
  // no spec for. nuqs writes per key, so this and `useAnalysisState` share the
  // URL without either clobbering the other — and the pins therefore survive
  // switching between the three bodies, which is the whole point of sharing the
  // selector bar.
  const [tab, setTab] = useQueryState("tab", { history: "replace" });
  // That param resolved to one of the three bodies, with anything unrecognised
  // falling back to the default. One selector rather than a boolean per body:
  // two booleans can both be true, and which one won would then depend on the
  // order the JSX happened to test them in.
  const body = tab === EVENTS_TAB ? EVENTS_TAB : tab === TIMELINE_TAB ? TIMELINE_TAB : TABLE_TAB;
  const caps = CAPABILITIES[state.metric];
  const spec = useMemo(() => resolveViewSpec(state, caps), [state, caps]);

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
    loadFromResponse,
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
    stackMode,
    setStackMode,
    setRateSmoothing,
    chartMarkers,
    maskBands,
    stateWindowBands,
    chartWindowTooltips,
  } = useChartModel({
    id,
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

  // Indexes arrive relative to the data the chart was given, so a drag while
  // already scoped is relative to the current window — offset it back into
  // whole-fight indexes before committing.
  const handleScope = useCallback(
    (next: [number, number] | null) => {
      if (next === null) {
        setState(windowTransition(state, null));
        return;
      }
      const offset = state.window === null ? 0 : state.window[0];
      setState(windowTransition(state, [next[0] + offset, next[1] + offset]));
    },
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

  if (!shownEncounter) return null;

  const windowLabel = range === null ? null : `${bucketLabel(range[0])} – ${bucketLabel(range[1])}`;
  const fullLabel = bucketLabel(Math.max(0, chartLen - 1));

  return (
    <Box className="analysis">
      <AnalysisTopBar />

      <QuestSummary
        encounter={shownEncounter}
        questId={questId}
        roomIndex={roomIndex}
        questCompleted={questCompleted}
        questTimer={questTimer}
        imported={imported}
        logId={Number.isFinite(Number(id)) ? Number(id) : null}
      />

      {/* WHO the page is about. It outranks everything below: the actor pin is
          the one selection the Events view and the table view read the same
          way, so it sits above the metric tabs rather than beside them. */}
      <ActorBar
        options={labelledOptions.sources}
        value={pins.source}
        onChange={(source) => handlePinsChange({ ...pins, source })}
        trailing={
          <MetricTabs
            variant="inline"
            ariaLabelKey="ui.logs.view-tablist-label"
            tabs={VIEW_TABS}
            value={body}
            onChange={(value) =>
              // Selecting the DEFAULT body clears the param rather than storing
              // "table": the table is the default, and a default in the URL is
              // noise. Anything else is written as-is. The metric the table was
              // last on is untouched either way — it lives in the machine, not
              // here.
              setTab(value === TABLE_TAB ? null : value)
            }
          />
        }
      />

      {/* Above the metric tabs, where Warcraft Logs puts it: rendering it below
          the switcher shifted every control under it each time the metric
          changed. Only metrics that declare `supportsHostility` can operate it
          — see HostilityToggle's `disabled`. */}
      <Box style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 16 }}>
        <HostilityToggle
          value={hostility}
          onChange={(side) => setState(hostilityTransition(state, side))}
          disabled={!caps.supportsHostility}
        />
      </Box>

      {/* Live in BOTH views, because Events is a display MODE and not a view of
          its own: the metric tab is what says which events the stream lists —
          Buffs → applies and removes, Damage Taken → incoming hits (see
          `eventScope`). Warcraft Logs' model, and the reason this frame is
          shared rather than swapped. */}
      <MetricTabs
        tabs={METRIC_TABS}
        value={metricKey}
        onChange={(value) => setState(metricTransition(state, value as MetricKey))}
      />

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

      <DpsChart
        data={shownChartData}
        labels={labels}
        labelKey={labelKey}
        // The table's own row-label key: the plot's series and the table's rows
        // are one set of things, so the tooltip's breakdown heads itself with
        // the same word the column below it does.
        sectionKey={spec.table.rowsLabelKey}
        format={format}
        stacked={stacked}
        onScope={handleScope}
        markers={chartMarkers}
        bands={maskBands}
        windowBands={stateWindowBands}
        windowTooltips={chartWindowTooltips}
        smoothing={smoothing}
        // Offered on RATE charts only. On a level (the undrilled SBA gauge, the
        // aura stacks) `chartPresentation` pins smoothing to 1 whatever is
        // chosen, so a control there would be a knob that does nothing.
        onSmoothingChange={format === "amount" ? setRateSmoothing : undefined}
        stackMode={chartSource === "stacks" ? stackMode : undefined}
        onStackModeChange={chartSource === "stacks" ? setStackMode : undefined}
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
    </Box>
  );
};
