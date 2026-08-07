import { Box } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { characterIconUrl } from "@/characterIcon";
import { emKeyOf, enemyAttackOrdinal } from "@/enemyAttackNames";
import { enemyIconUrl } from "@/enemyIcon";
import { ViewModeToggle } from "@/pages/logs/view/ViewModeToggle";
import { statusClassName } from "@/statusClassName";
import { statusIconUrl } from "@/statusIcon";
import { EncounterStateResponse, useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type {
  AbilitySeries,
  ActionType,
  CharacterType,
  ComputedPlayerState,
  EncounterState,
  EnemyType,
  GroupAbilityFilter,
  GroupAggregate,
  SelectionFact,
  StatusInterval,
  WireGroupQuery,
} from "@/types";
import {
  PLAYER_COLORS,
  causeSkillName,
  formatInPartyOrder,
  getSkillName,
  humanizeNumber,
  millisecondsToElapsedFormat,
  resolvePlayerColor,
  targetLabelKey,
  translateCharacterType,
  translateEnemyType,
  translateStatusName,
  translatedPlayerName,
} from "@/utils";

import {
  DPS_BUCKET_MS,
  DPS_SMOOTHING_WINDOW,
  HP_SERIES_COLORS,
  mantineColorVar,
  type ChartDatapoint,
  type Label,
} from "../DetailCharts";
import { abilityKey, skillKeyPayload } from "../abilityKey";
import { actionsForPin, childOfPin } from "../abilitySkills";
import { actorColor, keyColor, type ActorColorContext } from "../actorColor";
import { EventsTab, type EventLabels } from "../events/EventsTab";
import type { ScopeProbes } from "../events/eventScope";
import { spawnSegmentAt } from "../events/eventTargets";
import {
  buffs,
  enemyHolderKey,
  heldByRoster,
  narrowedByPins,
  narrowedStatusIntervals,
  slotsOf,
} from "../metrics/buffs";
import { damageDone, parseEnemyRow } from "../metrics/damageDone";
import { damageTaken, takenAttackNameKey, takenAttackRowParts } from "../metrics/damageTaken";
import { debuffs } from "../metrics/debuffs";
import { sba, sbaCauseLabel } from "../metrics/sba";
import { isHarmful } from "../metrics/statusPolarity";
import { stun } from "../metrics/stun";
import type { Hostility, MetricDescriptor, MetricRow } from "../metrics/types";
import { deriveSelectorOptions, type SelectorPins } from "../selectorOptions";
import { clipToWindow, isStatusPin, statusPinKey, uptimeMs } from "../statusUptime";
import { buildTargetLabels } from "../targetLabels";

import { ActorBar } from "./ActorBar";
import { AuraStrip, type AuraChip } from "./AuraStrip";
import { DebugBar } from "./DebugBar";
import { DpsChart, type StackMode } from "./DpsChart";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTable } from "./MetricTable";
import { MetricTabs, type MetricTab } from "./MetricTabs";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { RegroupStrip } from "./RegroupStrip";
import { WindowStrip } from "./WindowStrip";
import { abilityBands } from "./abilityBands";
import { abilityLabelFor, abilityOwnerFor } from "./abilityLabel";
import "./analysis.css";
import { auraExcludedBands, auraHolderIntervals, type AuraHolder } from "./auraWindows";
import { CAUSE_CLASS_LABEL_KEY, causeClassOfKey, withProvenance } from "./causeClass";
import { SBA_MARKER_COLOR, extractMarkers, type ChartMarker, type MarkerKind } from "./chartMarkers";
import { chartPresentation } from "./chartPresentation";
import { TOTAL_SERIES_KEY, buildSeriesPoints, withTotalSeries } from "./chartSeries";
import { WINDOW_BAND_COLOR, WINDOW_LABEL_KEY, windowBandsFor } from "./chartWindowBands";
import {
  admittedBucketsOf,
  intersectWireWindows,
  maskStatusIntervals,
  selectedChartWindows,
  windowFilterScrubRange,
} from "./chartWindowFilter";
import { windowMetricAmount, windowTooltipEntries } from "./chartWindowTooltip";
import { qualifiedAbilityLabels } from "./labelCollision";
import { labelSourceOptions, legendLabelFor } from "./legendLabel";
import { CAPABILITIES, levelFor } from "./machine/capabilities";
import { groupBandsFor, groupRowsFor } from "./machine/groupRows";
import { GROUP_TOP_N, resolveViewSpec, universeOf } from "./machine/resolve";
import { auraAnchorOf, auraPinKey, type MetricKey } from "./machine/state";
import {
  setAura as auraTransition,
  clearPin,
  setHostility as hostilityTransition,
  setMetric as metricTransition,
  pinRow,
  regroup,
  setWindowFilter as windowFilterTransition,
  setWindow as windowTransition,
} from "./machine/transitions";
import { useAnalysisState } from "./machine/useAnalysisState";
import { identityPartyOf } from "./partyIdentity";
import { rowCardSectionsFor } from "./rowCardSections";
import { abilityRowIconUrl } from "./rowIcon";
import { buildEffectSeries, buildStatusSeries } from "./statusChart";
import {
  casterActionOf,
  causeCandidatesOf,
  causeNameFor,
  statusIdOfKey,
  statusKeyParts,
  statusLabelFor,
  statusRowKindFor,
  targetRowLabel,
  targetRowSegment,
} from "./statusLabel";
import { withStatusOption } from "./statusOption";
import { statusRowColors } from "./statusRowColors";
import { useUrlQueryString } from "./useUrlQueryString";
import { windowChips } from "./windowChips";
import { wireWindowsFrom } from "./wireWindows";

/** The metric switcher's contents, in display order. Adding a metric that only
 * has a friendly side is adding a descriptor here — the frame itself does not
 * change.
 *
 * An ENEMY side still costs more than the descriptor: which hover card
 * decomposes its rows (`rowSections`), which series its bands come from
 * (`hostilitySeriesFor`), what the plot is titled and what an empty table says
 * all branch on `metricKey` rather than reading the descriptor. Folding those
 * four onto `MetricDescriptor` is a deliberate follow-up — worth doing when a
 * third hostility-capable damage tab exists to generalise against, not
 * speculatively against two. */
const METRICS: Record<string, MetricDescriptor> = { damage: damageDone, taken: damageTaken, stun, sba, buffs, debuffs };

/** The switcher's contents, derived from METRICS — each descriptor already
 * carries the label the tab shows, and two lists that must agree is one list
 * too many. Insertion order above is the display order. */
const METRIC_TABS: MetricTab[] = Object.entries(METRICS).map(([value, descriptor]) => ({
  value,
  labelKey: descriptor.labelKey,
}));

/** The raw-event-stream view's value in the top-level switch, and in the `tab`
 * URL param. Its absence means the default view, the table. */
const EVENTS_TAB = "events";
/** The default view: the chart-and-table body, everything the metric tabs
 * switch between. Never written to the URL — a default in the URL is noise. */
const TABLE_TAB = "table";

/** The top-level switch, which changes the WHOLE body below the selector bar.
 *
 * Events is here rather than alongside the metrics because it is not a metric —
 * it has no chart, no groupings, no numeric columns and no side, so there is
 * nothing for `CAPABILITIES`/`resolveViewSpec` to answer for it, and nothing for
 * the hostility toggle or the metric tabs to mean while it is showing. It rides
 * its own `tab` param instead of `state.metric`, so the pins survive switching
 * between the two views — which is the point of sharing the selector bar. */
const VIEW_TABS: MetricTab[] = [
  { value: TABLE_TAB, labelKey: "ui.logs.view-table-tab" },
  { value: EVENTS_TAB, labelKey: "ui.logs.events-tab" },
];

/** Tooltip line per marker kind. Sibling of `DpsChart`'s `MARKER_LABEL_KEY`, but
 * a separate key set: those name the control-row checkboxes, these are the
 * strings the tooltip lists under a marker line. */
const MARKER_LINE_KEY: Record<MarkerKind, string> = {
  death: "ui.logs.chart-marker-death-line",
  sba: "ui.logs.chart-marker-sba-line",
};

/** Bucket index → "M:SS", for the window readout. */
const bucketLabel = (bucket: number) => millisecondsToElapsedFormat(bucket * DPS_BUCKET_MS);

/** Stable empty map, so the drill memo below does not rebuild every render on a
 * fresh `{}` literal. */
const EMPTY_ABILITY_SERIES: Record<number, AbilitySeries[]> = {};

export const AnalysisView = () => {
  const { t, i18n } = useTranslation();
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

  const { show_display_names, streamer_mode, player_label_template, color_1, color_2, color_3, color_4 } =
    useMeterSettingsStore(
      useShallow((state) => ({
        show_display_names: state.show_display_names,
        streamer_mode: state.streamer_mode,
        player_label_template: state.player_label_template,
        color_1: state.color_1,
        color_2: state.color_2,
        color_3: state.color_3,
        color_4: state.color_4,
      }))
    );

  // The machine: the URL holds the WHOLE state (metric, side, pins, window,
  // grouping override), the resolver turns it into everything the view shows.
  const [state, setState] = useAnalysisState();
  // Which BODY the frame shows — the top-level view switch. Its own nuqs key
  // rather than a machine field: Events is not a metric, so putting it in
  // `AnalysisState` would mean a `MetricKey` the resolver has no spec for. nuqs
  // writes per key, so this and `useAnalysisState` share the URL without either
  // clobbering the other — and the pins therefore survive switching between the
  // two bodies, which is the whole point of sharing the selector bar.
  const [tab, setTab] = useQueryState("tab", { history: "replace" });
  const onEvents = tab === EVENTS_TAB;
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
  // Meter state, facts and group aggregates re-derived under the current
  // pins, window and grouping. Null means "the base load already says it".
  const [scoped, setScoped] = useState<{
    state: EncounterState;
    facts: SelectionFact[];
    groups: GroupAggregate[];
    /** The drilled Stun/SBA bands, keyed by player. Only this fetch carries
     * them — the base load ignores pins, and a drill IS a pin. */
    abilitySeries: Record<number, AbilitySeries[]>;
  } | null>(null);

  // Responses are not ordered with respect to their requests (the command is
  // `#[tauri::command(async)]`), so each one drops itself once superseded.
  // Counted separately from the base load: a pin change must not cancel a load.
  const loadGeneration = useRef(0);
  const scopeGeneration = useRef(0);

  // The wire query the base load sent (as its JSON identity), so the scoped
  // effect can tell "the base response already answered this grouping" from
  // "a regroup needs its own fetch". Refs rather than deps: the base load
  // must not re-run — full charts and party — on every pin or regroup.
  const wireQueryRef = useRef<WireGroupQuery | undefined>(undefined);
  const baseQueryKeyRef = useRef<string | null>(null);

  // The window the status tables measure, in milliseconds from the fight's
  // start. Buckets are inclusive at both ends, so the last one runs to the start
  // of the one after it — the same conversion the scoped fetch and the chart
  // bands use, kept in one place so the three cannot drift.
  //
  // Declared HERE, above the fetch memos, because the filters' window masks
  // ride the queries: `auraWindows`/`windowFilterWindows` clip against this,
  // and `wireQuery`/the scoped fetch read the combined mask. Below them it
  // would be a use-before-declaration.
  const statusWindow = useMemo(
    () => ({
      startMs: (range === null ? 0 : range[0]) * DPS_BUCKET_MS,
      endMs: (range === null ? chartLen : range[1] + 1) * DPS_BUCKET_MS,
    }),
    [range, chartLen]
  );

  // The uptime denominator: the window's own length, so a scrubbed table reports
  // uptime WITHIN the window rather than diluting it across a fight the chart is
  // no longer showing. The window spans whole buckets, so it is never SHORTER
  // than the intervals inside it — which is what a `(chartLen - 1)` denominator
  // was, against intervals the backend closes at the exact final millisecond.
  const fightDurationMs = statusWindow.endMs - statusWindow.startMs;

  // Cropped to that same window, so numerator and denominator measure one span.
  const windowedIntervals = useMemo(
    () => clipToWindow(statusIntervals, statusWindow.startMs, statusWindow.endMs),
    [statusIntervals, statusWindow]
  );

  // The base load: the full fight, unpinned. Owns the charts, the party and the
  // quest metadata, none of which a pin changes. Carries the CURRENT group
  // query too, so the groups path has rows and bands on first paint.
  useEffect(() => {
    const generation = ++loadGeneration.current;
    scopeGeneration.current += 1;
    const groupQuery = wireQueryRef.current;
    baseQueryKeyRef.current = groupQuery === undefined ? null : JSON.stringify(groupQuery);
    invoke("fetch_encounter_state", { id: Number(id), options: { filters, groupQuery } })
      .then((result) => {
        if (generation !== loadGeneration.current) return;
        loadFromResponse(result as EncounterStateResponse);
        setScoped(null);
      })
      .catch((e) => {
        if (generation !== loadGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, filters, loadFromResponse]);

  // A pinned target is a SPAWN (an index into `targetEntries`), and the backend
  // filters by that spawn's span. Deliberately not the actor id: the game
  // reissues a dead boss's id to a later one, so filtering by id sent every span
  // that id ever had and pinning Wilinus Icewyrm also returned Vrazarek
  // Firewyrm's damage. An index with no entry is dropped rather than widening
  // the filter — a stale URL narrows to nothing, which the empty table shows.
  const targetSpans = useMemo(
    () =>
      pins.targets
        .map((segment) => targetEntries[segment])
        .filter((entry) => entry !== undefined)
        .map((entry) => ({ id: entry.id, startMs: entry.startMs, endMs: entry.endMs })),
    [pins.targets, targetEntries]
  );

  // Every action anyone used in the WHOLE fight, for expanding a pinned row into
  // the raw actions behind it. The base load, not the scoped state: the scoped
  // one is already narrowed by the very pin being expanded.
  //
  // Breakdown rows AND facts. A breakdown row carries only the payload its row
  // was folded onto, so the echo row names one `SupplementaryDamage(n)` of the
  // dozens it aggregates; the facts carry each distinct action, which is what
  // makes a pinned echo filter to the same damage the row reports.
  const everySkill = useMemo(
    () => [
      ...Object.values(encounter?.party ?? {}).flatMap((player) => player.skillBreakdown),
      ...baseFacts.map((fact) => ({ actionType: fact.ability, childCharacterType: fact.childCharacterType ?? "" })),
    ],
    [encounter, baseFacts]
  );

  // A pinned row can be a condensed GROUP, which the backend knows nothing
  // about — it filters on raw action ids. Expanded here, from what the party
  // actually used, so the parser stays free of a display concern and the filter
  // can never widen to ids nobody landed.
  // A status pin names an effect, not an action — the backend filters on raw
  // action ids and would narrow the fight to nothing at all. Left empty, the
  // damage tables stay whole while a buff is pinned on its own tab.
  const pinnedActions = useMemo(
    () => (pins.ability === null || isStatusPin(pins.ability) ? [] : actionsForPin(pins.ability, everySkill)),
    [pins.ability, everySkill]
  );

  // The active aura's admitted windows — the pinned holder's intervals of the
  // chosen effect, clipped to the chart window. Computed here rather than in
  // the resolver because they need the fight's status intervals. Undefined =
  // no aura in the query; an EMPTY array is a real mask (the effect was never
  // up inside the window) and narrows to nothing.
  const auraWindows = useMemo(() => {
    const aura = spec.fetch?.aura ?? null;
    if (aura === null) return undefined;
    const anchor = auraAnchorOf(aura);
    const index = anchor === "source" ? state.source : state.target;
    if (anchor === null || index === null) return undefined;
    const holder: AuraHolder =
      universeOf(anchor, hostility) === "player" ? { kind: "player", index } : { kind: "enemySpawn", segment: index };
    return wireWindowsFrom(auraHolderIntervals(statusIntervals, auraPinKey(aura), holder), statusWindow);
  }, [spec.fetch, state.source, state.target, hostility, statusIntervals, statusWindow]);

  // The window filter's admitted spans. Undefined = no filter; an EMPTY array
  // is a real mask (a stale individual index) and narrows to nothing.
  const windowFilterWindows = useMemo(
    () =>
      state.win === null ? undefined : wireWindowsFrom(selectedChartWindows(chartWindows, state.win), statusWindow),
    [state.win, chartWindows, statusWindow]
  );

  // What every masked consumer reads: the aura filter and the window filter
  // INTERSECTED when both are active. One combined mask feeds the group query,
  // the derived reparse and the excluded shading, so the table, the hover
  // cards and the plot all answer for the same filtered fight.
  const maskWindows = useMemo(() => {
    if (auraWindows === undefined) return windowFilterWindows;
    if (windowFilterWindows === undefined) return auraWindows;
    return intersectWireWindows(auraWindows, windowFilterWindows);
  }, [auraWindows, windowFilterWindows]);

  // The buffs/debuffs tables under the window filter: intervals clipped to the
  // admitted spans, so uptime reports only masked time. `applications` is
  // re-counted per `maskStatusIntervals`'s start-attribution rule — a piece
  // counts only in the span containing the interval's original apply moment —
  // so a buff spanning several admitted spans is still Count 1, not one per
  // piece. The chips and selector options stay on the UNmasked window — they
  // are pick lists, and a filter must not hide the things that operate it.
  //
  // Declared here, below `maskWindows`, rather than beside `windowedIntervals`
  // above (which it otherwise reads from) — it depends on `maskWindows`, which
  // depends on `auraWindows`, both declared after `windowedIntervals`.
  const maskedIntervals = useMemo(
    () => (maskWindows === undefined ? windowedIntervals : maskStatusIntervals(windowedIntervals, maskWindows)),
    [windowedIntervals, maskWindows]
  );

  // The resolver's fetch, expanded into the wire shape: the raw ability pin
  // becomes whichever `AbilityFilter` grammar the query's event stream reads
  // (a friendly action list on the dealt stream, one enemy attack on the
  // taken one — a pin in the wrong grammar for the stream narrows nothing),
  // and the committed window is stamped on so the measures follow the scrub.
  const wireQuery = useMemo((): WireGroupQuery | undefined => {
    if (spec.fetch === null) return undefined;
    const dealtStream = (spec.fetch.metric === "damage") === (spec.fetch.hostility === "friendly");
    let ability: GroupAbilityFilter | null = null;
    if (spec.fetch.ability !== null) {
      const attack = takenAttackRowParts(spec.fetch.ability);
      if (dealtStream && attack === null) {
        ability = { kind: "friendly", actions: actionsForPin(spec.fetch.ability, everySkill) };
      } else if (!dealtStream && attack !== null) {
        ability = { kind: "enemyAttack", enemyType: attack.enemyType, actionId: attack.actionId };
      }
    }
    return {
      metric: spec.fetch.metric,
      hostility: spec.fetch.hostility,
      groupBy: spec.fetch.groupBy,
      source: spec.fetch.source,
      target: spec.fetch.target,
      ability,
      topN: spec.fetch.topN,
      // Buckets are inclusive at both ends, so the cutoff has to admit all of
      // the last one — `end * 1000` would window one bucket short.
      ...(state.window === null
        ? {}
        : { fromMs: state.window[0] * DPS_BUCKET_MS, upToMs: (state.window[1] + 1) * DPS_BUCKET_MS - 1 }),
      // The combined aura∩window mask rides the same query, so the table, the
      // rows and the chart bands all answer for the same filtered fight.
      ...(maskWindows === undefined ? {} : { windows: maskWindows }),
    };
  }, [spec.fetch, everySkill, state.window, maskWindows]);
  wireQueryRef.current = wireQuery;
  // The query's JSON identity, for "is a refetch needed at all" below — the
  // object is rebuilt every render, so identity comparison would always refetch.
  const wireQueryKey = useMemo(() => (wireQuery === undefined ? null : JSON.stringify(wireQuery)), [wireQuery]);

  // The scoped fetch's own request, everything `fetch_encounter_state` needs
  // BESIDES the group query (which rides `wireQueryRef` for the same reason).
  // `filters`, `targetSpans` and `pinnedActions` are fresh references on most
  // renders even when nothing they carry has changed — clicking between two
  // different status pins rebuilds `pinnedActions` to a new but equally EMPTY
  // array both times — so the effect below keys off this object's JSON
  // identity rather than the raw fields, the same idiom as `wireQuery`/
  // `wireQueryKey`.
  // The per-ability chart request. Only the derived-path tabs (Stun, SBA) drilled
  // by ability: damage and taken already get their bands from the group query,
  // and the aura tabs build theirs client-side from the status intervals.
  //
  // Rides the SCOPED fetch rather than the base load, because a drill is a pin
  // change and the base load deliberately ignores pins.
  const abilityQuery = useMemo(() => {
    if (caps.dataPath !== "derived" || spec.groupBy !== "ability") return undefined;
    return {
      metric: metricKey as "stun" | "sba",
      // Stun's ability level widens to the whole party with no source pinned
      // (see metrics/stun.ts); SBA has no party-wide reading, but its table is
      // empty there anyway, so one rule covers both.
      ...(pins.source === null ? {} : { player: pins.source }),
    };
  }, [caps.dataPath, spec.groupBy, metricKey, pins.source]);

  const scopedOptions = useMemo(
    () => ({
      filters,
      targetSpans,
      selection: {
        sourceIndices: pins.source === null ? [] : [pins.source],
        abilities: pinnedActions,
      },
      // Buckets are inclusive at both ends, so the cutoff has to admit all of
      // the last one — `end * 1000` would reparse a window one bucket short.
      ...(range === null ? {} : { fromMs: range[0] * DPS_BUCKET_MS, upToMs: (range[1] + 1) * DPS_BUCKET_MS - 1 }),
      ...(maskWindows === undefined ? {} : { windows: maskWindows }),
      // In `scopedOptions`, not bolted on at the call site like `groupQuery`,
      // so it lands in `scopedOptionsKey` too — otherwise regrouping to the
      // ability dimension would change the request without triggering it.
      ...(abilityQuery === undefined ? {} : { abilitySeries: abilityQuery }),
      stateOnly: true,
    }),
    [filters, targetSpans, pins.source, pinnedActions, range, maskWindows, abilityQuery]
  );
  const scopedOptionsRef = useRef(scopedOptions);
  scopedOptionsRef.current = scopedOptions;
  const scopedOptionsKey = useMemo(() => JSON.stringify(scopedOptions), [scopedOptions]);

  // The early-out's own inputs, in a ref rather than the fetch effect's
  // dependency array. `pins.ability` flipping between two status pins is a
  // genuine VALUE change but not a genuine REQUEST change (a status pin
  // narrows nothing the backend knows about — the request above deliberately
  // sends `abilities: []` for one); if that value change forced the effect to
  // rerun, the mask clause below would fall all the way through to a fetch
  // regardless — a mask makes the gate unconditional once inside, so keeping
  // the effect from firing AT ALL on a no-op change is the only lever left.
  const earlyOutRef = useRef({ pinned: false, isWindowed: false, hasMask: false, wantsBands: false });
  earlyOutRef.current = {
    pinned: pins.source !== null || (pins.ability !== null && !isStatusPin(pins.ability)) || targetSpans.length > 0,
    isWindowed: range !== null,
    hasMask: maskWindows !== undefined,
    // A regroup to the ability dimension with nothing pinned is a real request
    // (stun's party-wide ability level), and none of the clauses above see it.
    wantsBands: abilityQuery !== undefined,
  };

  // The scoped fetch: everything the selector bar, the window, the grouping
  // and the filter masks change. Keyed on `scopedOptionsKey`/`wireQueryKey` —
  // the request's own content — not the raw pins/spans/mask, so a request
  // byte-identical to the last one sent (clicking between two status pins,
  // for instance) does not repeat a decompress-and-reparse the store already
  // has the answer to. Sends `stateOnly` because the charts stay from the
  // base load — the backend still returns selection facts there, so the
  // cascade re-narrows with the window — and carries the group query for the
  // groups-path table.
  useEffect(() => {
    const { pinned, isWindowed, hasMask, wantsBands } = earlyOutRef.current;
    // A regroup with nothing pinned still needs ITS grouping's aggregates —
    // unless the base load already fetched this exact query.
    const needsGroups = wireQueryKey !== null && wireQueryKey !== baseQueryKeyRef.current;
    if (!pinned && !isWindowed && !needsGroups && !hasMask && !wantsBands) {
      setScoped(null);
      return;
    }

    const generation = ++scopeGeneration.current;
    invoke("fetch_encounter_state", {
      id: Number(id),
      options: { ...scopedOptionsRef.current, groupQuery: wireQueryRef.current },
    })
      .then((result) => {
        if (generation !== scopeGeneration.current) return;
        const response = result as EncounterStateResponse;
        // Normalised here, at the boundary: the Rust binary does not hot-reload,
        // so a frontend ahead of its backend must degrade to "no groups"
        // rather than throw on a field the running binary never sends.
        setScoped({
          state: response.encounterState,
          facts: response.selectionFacts ?? [],
          groups: response.groups ?? [],
          // Normalised at the boundary like `groups`: the Rust binary does not
          // hot-reload, so a frontend ahead of its backend degrades to no bands
          // — and therefore to the per-player lines — rather than throwing.
          abilitySeries: response.abilitySeries ?? {},
        });
      })
      .catch((e) => {
        if (generation !== scopeGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, scopedOptionsKey, wireQueryKey]);

  // Which aggregates the groups path renders: the scoped fetch's when one is
  // in hand, else the base load's — valid only while the current query IS the
  // one the base load sent (the effect above refetches whenever it is not).
  const groups = scoped?.groups ?? baseGroups;
  // No base-load fallback: the base load never asks for bands, so an empty map
  // is the honest answer whenever no scoped response has supplied them.
  const scopedAbilitySeries = scoped?.abilitySeries ?? EMPTY_ABILITY_SERIES;

  const shownEncounter = scoped?.state ?? encounter;

  // Figures for the current pins and window.
  const players = useMemo(() => (shownEncounter ? formatInPartyOrder(shownEncounter.party) : []), [shownEncounter]);

  // Identity — names, party slots, colours — always from the FULL party, so a
  // pin cannot promote the pinned player to slot 0 and steal slot 0's name and
  // colour.
  const identityPlayers = useMemo(
    () => identityPartyOf(encounter?.party ?? null, shownEncounter?.party ?? null),
    [encounter, shownEncounter]
  );

  // Cascading options come from the facts for the CURRENT window but with no
  // pin applied — a selector must keep offering what the other pins allow.
  const facts = scoped?.facts ?? baseFacts;
  const options = useMemo(() => deriveSelectorOptions(facts, pins), [facts, pins]);

  // The party palette. Declared HERE, well above the chart it was written for,
  // because the events stream colours its rows by the acting player and needs
  // it long before the plot does — one palette, so a player is the same colour
  // in the plot, the table and the raw stream.
  const colors = useMemo(() => [color_1, color_2, color_3, color_4], [color_1, color_2, color_3, color_4]);

  // The eight-entry palette the chart already draws with, so a player is the
  // same colour in the table as in the plot above it.
  const palette = useMemo(() => [...colors, ...PLAYER_COLORS.slice(4)], [colors]);

  // Player labels are looked up by actor index, which is what a pin carries.
  const playerByIndex = useMemo(() => {
    const byIndex = new Map<number, { player: ComputedPlayerState; slot: number }>();
    identityPlayers.forEach((player) => byIndex.set(player.index, { player, slot: player.partyIndex }));
    return byIndex;
  }, [identityPlayers]);

  const labelForSource = useCallback(
    (index: number) => {
      const found = playerByIndex.get(index);
      if (!found) return String(index);
      return translatedPlayerName(
        found.slot,
        playerData[found.slot] ?? null,
        found.player,
        show_display_names && !streamer_mode,
        player_label_template
      );
    },
    [playerByIndex, playerData, show_display_names, streamer_mode, player_label_template]
  );

  // Skill names are per character, so an ability is named against the first
  // player who used it. identityPlayers, not players: the options span the whole
  // fight while the scoped party holds only the pinned player, so searching the
  // scoped one left every other player's abilities showing their raw key.
  const labelForAbility = useCallback(
    // The pinned source is preferred: with one pinned the rows and options are
    // that player's own, and a shared action id must take THEIR skill's name.
    (key: string) => abilityLabelFor(key, identityPlayers, getSkillName, playerByIndex.get(pins.source ?? -1)?.player),
    // i18n.language: skill names are translated, so a language switch must
    // re-derive them even though it is not read here directly.
    [identityPlayers, playerByIndex, pins.source, i18n.language]
  );

  // One enemy attack, named as "<Enemy> — Attack <id>": enemy actions carry no
  // names in the game data, so the id plus the attacker is the honest label.
  const labelForTakenAttack = useCallback(
    (enemyType: EnemyType, actionId: ActionType) => {
      // A derived callout name wins; the raw id is the fallback, not a peer.
      // Most attacks have no derived pair (the id→ordinal edge is live-capture
      // work), so this falls through to "Attack N" far more often than not.
      const ordinal = enemyAttackOrdinal(enemyType, actionId);
      const emKey = ordinal === null ? null : emKeyOf(enemyType);
      if (ordinal !== null && emKey !== null) {
        const name = t(`enemy-attacks:${emKey}.${ordinal}`, { defaultValue: "" });
        if (name !== "") return `${translateEnemyType(enemyType)} — ${name}`;
      }
      const { key, params } = takenAttackNameKey(actionId);
      return `${translateEnemyType(enemyType)} — ${t(key, params)}`;
    },
    // i18n.language: both the enemy and the attack names are translated.
    [t, i18n.language]
  );

  // The row-label form of the same name, off the JSON label the taken rows
  // carry (see `takenAttackRowParts` — the grammar has one author).
  const takenAttackLabel = useCallback(
    (label: string) => {
      const parts = takenAttackRowParts(label);
      return parts ? labelForTakenAttack(parts.enemyType, parts.actionId) : label;
    },
    [labelForTakenAttack]
  );

  // The same rule the quest view's HP-chart legend and target filter label with,
  // so one enemy reads the same way everywhere: "#n" only once a name repeats.
  const targetLabels = useMemo(
    () => buildTargetLabels(targetEntries, translateEnemyType),
    // i18n.language: the labels embed translated enemy names.
    [targetEntries, i18n.language]
  );

  // Indexed, not searched by id: two spawns can share a recycled actor id, and
  // `find` then answered with the first of them for both — which is how one of
  // the Four Dragons lost its name and the other took its damage.
  const labelForTarget = useCallback(
    (segment: number) => {
      const entry = targetEntries[segment];
      if (!entry) return String(segment);
      return targetLabels.get(targetLabelKey(entry.enemyType, entry.instance)) ?? translateEnemyType(entry.enemyType);
    },
    [targetEntries, targetLabels]
  );

  // The breaking enemy's display name, through the same spawn table the
  // target rows use — matched on actor index AND time overlap, because the
  // game reissues a dead boss's actor index to a later spawn.
  const breakEnemyOf = useCallback(
    (actorIndex: number | null, span: { startMs: number; endMs: number }): string | null => {
      if (actorIndex === null) return null;
      const segment = targetEntries.findIndex(
        (entry) => entry.actorIndex === actorIndex && entry.startMs < span.endMs && entry.endMs > span.startMs
      );
      return segment === -1 ? null : labelForTarget(segment);
    },
    [targetEntries, labelForTarget]
  );

  // The Events body's pins, resolved out of the machine's index spaces into the
  // ones a raw event carries (see `filterByPins`). Declared here because the
  // target dimension needs `targetEntries`' spawn table.
  const eventPins = useMemo(
    () => ({
      // Already the same space as a damage event's `source.parent_index`.
      source: pins.source,
      // A pinned target is a SPAWN, so it travels as BOTH of that spawn's ids
      // plus its span. Both because the rows it filters are not all in one
      // index space (see `ActorSpace`): a damage row carries the folded
      // instance pointer, a status row the game's actor index. The span is what
      // separates a reissued actor index's two spawns.
      targetSpans: pins.targets
        .map((segment) => targetEntries[segment])
        .filter((entry) => entry !== undefined)
        .map((entry) => ({
          spawnId: entry.id,
          actorIndex: entry.actorIndex,
          startMs: entry.startMs,
          endMs: entry.endMs,
        })),
      // `pinnedActions` is the expansion the view already computes for its own
      // fetch, so a condensed `Group:` pin matches the raw ids behind it. An
      // EMPTY set with an ability pinned narrows to nothing, which is the honest
      // answer for a status pin — it names no action at all.
      abilityKeys: pins.ability === null ? null : new Set(pinnedActions.map(abilityKey)),
    }),
    [pins.source, pins.targets, pins.ability, pinnedActions, targetEntries]
  );

  // The Windows strip's chips: the filter UI for the battle windows. Declared
  // here (after `breakEnemyOf`/`labelForTarget`, not immediately after
  // `maskedIntervals`) because it closes over `breakEnemyOf`, which itself
  // needs `targetEntries`' spawn table — declared later in this file than
  // `maskedIntervals`.
  const windowFilterChips = useMemo(
    () =>
      windowChips(chartWindows, state.win, {
        kindLabel: (kind) => t(WINDOW_LABEL_KEY[kind]),
        kindChipLabel: (label, count) => t("ui.logs.window-chip-kind", { label, count }),
        rangeLabel: (startMs, endMs) => `${millisecondsToElapsedFormat(startMs)}–${millisecondsToElapsedFormat(endMs)}`,
        durationLabel: (ms) => t("ui.logs.window-chip-duration", { seconds: Math.round(ms / 1000) }),
        breakEnemyLabel: (actorIndex, span) => breakEnemyOf(actorIndex, span),
      }),
    // i18n.language: the kind and duration labels are translated.
    [chartWindows, state.win, t, breakEnemyOf, i18n.language]
  );

  // A dropdown entry carries no rank, position or colour, so two players the
  // template renders identically ("AI" under a {name}-only template) are told
  // apart by character — the same rule the chart legend labels with.
  const characterForSource = useCallback(
    (index: number) => {
      const found = playerByIndex.get(index);
      return found ? translateCharacterType(found.player.characterType) : "";
    },
    // i18n.language: character names are translated.
    [playerByIndex, i18n.language]
  );

  // Every status window filed under the row key it belongs to, in one pass.
  // Both the row labels and the chart bands need "the intervals for this key",
  // and each scanning the whole fight per key made them quadratic together.
  const intervalsByPinKey = useMemo(() => {
    const byKey = new Map<string, StatusInterval[]>();
    for (const interval of statusIntervals) {
      const key = statusPinKey(interval);
      const group = byKey.get(key);
      if (group) group.push(interval);
      else byKey.set(key, [interval]);
    }
    return byKey;
  }, [statusIntervals]);

  // A cause is the CASTER's action id, so it is named through the tables of
  // that row's own casters (and their sub-actors) — never the whole party,
  // whose colliding action ids fabricated cross-character names.
  const causeCandidates = useMemo(() => {
    const byKey = new Map<string, CharacterType[]>();
    for (const [key, group] of intervalsByPinKey) {
      byKey.set(
        key,
        causeCandidatesOf(group, (index) => playerByIndex.get(index)?.player)
      );
    }
    return byKey;
  }, [intervalsByPinKey, playerByIndex]);

  // The same name the effect's own row shows. Extracted because the Ability
  // selector must display the pinned effect too, and a second spelling of this
  // would let the selector and the table name one effect two ways.
  const statusDisplayLabel = useCallback(
    (key: string) => {
      const candidates = causeCandidates.get(key) ?? [];
      // The two fallbacks for a row the cause cannot name — a sentinel cause
      // means no activated action produced the effect. The caster action is
      // read off the row's own intervals (it is labelling payload, never part
      // of the key); the class comes out of the key itself.
      const casterAction = casterActionOf(intervalsByPinKey.get(key) ?? []);
      const classHash = statusKeyParts(key)?.classHash ?? null;
      return statusLabelFor(key, t, {
        effect: translateStatusName,
        cause: (id) =>
          causeNameFor(
            id,
            (cause) => causeSkillName(candidates, cause),
            // The caster action is the same id space as the cause, so it
            // resolves through the same caster-scoped tables.
            () => (casterAction === null ? "" : causeSkillName(candidates, casterAction)),
            () => statusClassName(classHash, t)
          ),
      });
    },
    // i18n.language: skill and band names are translated.
    [t, causeCandidates, intervalsByPinKey, i18n.language]
  );

  // The aura chip strips (WCL's Source/Target Auras Filter): the effects the
  // pinned actor held inside the current chart window, uptime measured
  // against that same window. Which universe the pin names follows the
  // hostility role-mapping (`universeOf`), the same rule the group query's
  // refs use — so a source chip strip on the enemy side is that SPAWN's
  // effects, not a player's.
  const auraChipsFor = useCallback(
    (anchor: "src" | "tgt"): AuraChip[] => {
      const dim = anchor === "src" ? ("source" as const) : ("target" as const);
      const index = anchor === "src" ? state.source : state.target;
      if (index === null) return [];
      const holder: AuraHolder =
        universeOf(dim, hostility) === "player" ? { kind: "player", index } : { kind: "enemySpawn", segment: index };
      const held = windowedIntervals.filter((interval) =>
        holder.kind === "player" ? interval.actorIndex === holder.index : interval.targetSegment === holder.segment
      );
      const byKey = new Map<string, StatusInterval[]>();
      for (const interval of held) {
        const key = statusPinKey(interval);
        const group = byKey.get(key);
        if (group) group.push(interval);
        else byKey.set(key, [interval]);
      }
      return [...byKey.entries()]
        .map(([key, group]) => {
          // The same art the effects table shows beside the same name — the
          // chip is that row's filter form, so the two must wear one picture.
          const statusId = statusIdOfKey(key);
          const iconUrl = statusId === null ? undefined : statusIconUrl(statusId);
          return {
            aura: `${anchor}:${key}`,
            label: statusDisplayLabel(key),
            uptimePercent:
              fightDurationMs === 0 ? 0 : Math.min(100, Math.round((uptimeMs(group) / fightDurationMs) * 100)),
            selected: state.aura === `${anchor}:${key}`,
            ...(iconUrl === undefined ? {} : { iconUrl }),
          };
        })
        .sort((a, b) => b.uptimePercent - a.uptimePercent);
    },
    [state.source, state.target, state.aura, hostility, windowedIntervals, statusDisplayLabel, fightDurationMs]
  );

  const sourceAuraChips = useMemo(
    () => (caps.supportsAuraFilter ? auraChipsFor("src") : []),
    [caps.supportsAuraFilter, auraChipsFor]
  );
  const targetAuraChips = useMemo(
    () => (caps.supportsAuraFilter ? auraChipsFor("tgt") : []),
    [caps.supportsAuraFilter, auraChipsFor]
  );

  // The art an OPTION wears. Each resolves through the same join `rowIconUrl`
  // sends the matching table row through, so pinning a row cannot change the
  // picture beside its name — the selector and the row it came from are the
  // same thing said twice, and they must look it. `undefined` is the common
  // answer, not a failure: trash mobs have no portrait and bare kinds (link
  // attacks, echoes, DoT) are not ability casts.
  const sourceIconUrl = useCallback(
    (index: number) => {
      const character = playerByIndex.get(index)?.player.characterType;
      return typeof character === "string" ? characterIconUrl(character) : undefined;
    },
    [playerByIndex]
  );

  // What every actor colour in the view is resolved against — the chart's
  // bands, the table's rows, the pin selectors' options and the events stream
  // all go through `actorColor` with this. One context so a boss cannot be pink
  // in the plot, grey in the table and uncoloured in the dropdown.
  //
  // `slotOf` reads the IDENTITY party, so a scoped fetch's renumbered slots
  // cannot recolour a player mid-drill, and answers `undefined` for a non-member
  // rather than falling back to slot 0 — which would paint every enemy in the
  // first player's colour.
  const colorContext: ActorColorContext = useMemo(
    () => ({ palette, partyData: playerData, slotOf: (index) => playerByIndex.get(index)?.slot }),
    [palette, playerData, playerByIndex]
  );

  const abilityOptionIconUrl = useCallback(
    (key: string) => {
      // A status pin names an EFFECT, not an action, so it takes the effects
      // table's art rather than the ability map's — which has no entry for it
      // and would answer with whichever action its fallback landed on.
      if (isStatusPin(key)) {
        const statusId = statusIdOfKey(key);
        return statusId === null ? undefined : statusIconUrl(statusId);
      }
      return abilityRowIconUrl(key, identityPlayers, playerByIndex.get(pins.source ?? -1)?.player);
    },
    [identityPlayers, playerByIndex, pins.source]
  );

  // The Events body's cells, named and pictured through the SAME resolvers the
  // metric table and the selectors use — a second spelling of either here would
  // let the two name one actor two ways, or pair one kind's name with another
  // kind's art. Declared HERE, below those resolvers rather than beside
  // `eventPins` above, because it closes over all three of them.
  //
  // ONE actor resolver for both ends of a row. The party is tried first, then
  // the spawn table in the index space the row declares (see `ActorSpace`), at
  // the moment of the event — the parser's own `segment_at` rule. A party
  // member resolves the same way in either space, because both capture paths
  // report one as a slot key.
  //
  // Colour is the point of the split: a player takes their own party colour,
  // an enemy takes its SPAWN's colour from the enemy palette. Neither answers
  // for the other, so a boss can never be drawn in a party member's colour.
  const eventLabels: EventLabels = useMemo(
    () => ({
      actor: (index, atMs, space) => {
        if (playerByIndex.has(index)) {
          return {
            name: labelForSource(index),
            iconUrl: sourceIconUrl(index),
            color: actorColor({ kind: "player", index }, colorContext),
          };
        }
        const segment = spawnSegmentAt(targetEntries, index, atMs, space);
        if (segment !== -1) {
          return {
            name: labelForTarget(segment),
            iconUrl: enemyIconUrl(targetEntries[segment]?.enemyType ?? null),
            color: actorColor({ kind: "spawn", segment }, colorContext),
          };
        }
        // Neither a party member nor a known spawn. The raw index is the honest
        // answer — it is what tells the reader the log holds an actor the
        // segmenter skipped, rather than quietly showing an empty cell. No
        // colour either: an actor we cannot name is not one we can categorise.
        return { name: String(index) };
      },
      // One resolver for the art of both, because `abilityOptionIconUrl` already
      // dispatches on the `status:` prefix — the selector needs the same split.
      ability: (key) => ({ name: labelForAbility(key), iconUrl: abilityOptionIconUrl(key) }),
      status: (key) => ({ name: statusDisplayLabel(key), iconUrl: abilityOptionIconUrl(key) }),
    }),
    [
      labelForSource,
      labelForTarget,
      labelForAbility,
      statusDisplayLabel,
      sourceIconUrl,
      colorContext,
      abilityOptionIconUrl,
      targetEntries,
      playerByIndex,
    ]
  );

  // How the event stream classifies an actor and an effect. Both come straight
  // from what the tables already use — the identity party for membership, the
  // game's own polarity flag for buff-vs-debuff — so the stream and the table
  // above it cannot disagree about who is in the party or what a debuff is.
  const eventProbes: ScopeProbes = useMemo(
    () => ({ isPartyMember: (index) => playerByIndex.has(index), isHarmful }),
    [playerByIndex]
  );

  const labelledOptions = useMemo(
    () => ({
      // Options wear their actor's own colour, the same one the chart band and
      // the table row take — a dropdown is where you pick the thing you are
      // about to look at, so it is the one place the colours must already
      // match. An ability has no actor and stays plain.
      sources: labelSourceOptions(options.sources, labelForSource, characterForSource, player_label_template).map(
        (option) => ({
          ...option,
          iconUrl: sourceIconUrl(Number(option.value)),
          color: actorColor({ kind: "player", index: Number(option.value) }, colorContext),
        })
      ),
      targets: options.targets.map((option) => ({
        ...option,
        label: labelForTarget(Number(option.value)),
        iconUrl: enemyIconUrl(targetEntries[Number(option.value)]?.enemyType ?? null),
        color: actorColor({ kind: "spawn", segment: Number(option.value) }, colorContext),
      })),
      // Icons AFTER `withStatusOption`, not before: the option it injects for a
      // pinned effect is not in the list it was given, and an icon pass on the
      // input would leave the one option that is definitely selected as the
      // only one with no art.
      abilities: withStatusOption(
        options.abilities.map((option) => ({ ...option, label: labelForAbility(option.value) })),
        pins.ability,
        statusDisplayLabel
      ).map((option) => ({ ...option, iconUrl: abilityOptionIconUrl(option.value) })),
    }),
    [
      options,
      labelForSource,
      characterForSource,
      player_label_template,
      labelForTarget,
      labelForAbility,
      pins.ability,
      statusDisplayLabel,
      sourceIconUrl,
      abilityOptionIconUrl,
      targetEntries,
      colorContext,
    ]
  );

  const metric = METRICS[metricKey] ?? damageDone;

  // Party slot per player index, for the group fold's row colours.
  const partySlots = useMemo(
    () => new Map(identityPlayers.map((player) => [player.index, player.partyIndex])),
    [identityPlayers]
  );

  // Which machinery produces rows is the metric's declared data path: the
  // groups path folds the fetched aggregates; the derived and interval paths
  // keep their descriptors exactly as before the machine.
  const groupsPath = caps.dataPath === "groups";

  const rows = useMemo(() => {
    if (groupsPath) {
      return groupRowsFor(groups, {
        metric: metricKey as "damage" | "taken",
        groupBy: spec.groupBy,
        hostility,
        partySlots,
        source: state.source,
        fightDurationMs,
      });
    }
    return shownEncounter
      ? metric.rows({
          encounter: shownEncounter,
          partyData: playerData,
          players,
          // The full party: `players` is the scoped one, and the status tables
          // use their roster to tell a buff from a debuff — a pinned source
          // would file the rest of the party's buffs as enemy-held.
          roster: identityPlayers,
          level,
          pins,
          statusIntervals: maskedIntervals,
          fightDurationMs,
          statusWindow,
          hostility,
        })
      : [];
  }, [
    groupsPath,
    groups,
    metricKey,
    spec.groupBy,
    partySlots,
    state.source,
    metric,
    shownEncounter,
    playerData,
    players,
    identityPlayers,
    level,
    pins,
    maskedIntervals,
    fightDurationMs,
    statusWindow,
    hostility,
  ]);

  // Child rows behind one table row — the descriptor's split bound to the
  // current derived state. The groups fetch produces the PARENTS; the children
  // come synchronously from the scoped derived party (the same data the hover
  // cards decompose), so expanding costs no fetch. Metrics without nesting
  // semantics declare no accessor and their rows keep only what they carry.
  const rowChildren = useCallback(
    (row: MetricRow) =>
      metric.children ? metric.children({ row, players, level, pins, hostility, fightDurationMs }) : null,
    [metric, players, level, pins, hostility, fightDurationMs]
  );

  // The character that tells two same-labelled ability rows apart: the child
  // character a group key carries (Id's own kit vs his dragonform's), else the
  // key's owning player — found by the same scan the label itself is named
  // through, so the qualifier can never name a different owner than the label.
  const abilityQualifier = useCallback(
    (key: string) => {
      const child = childOfPin(key);
      if (child !== null) return translateCharacterType(child);
      const owner = abilityOwnerFor(key, identityPlayers, playerByIndex.get(pins.source ?? -1)?.player);
      return owner ? translateCharacterType(owner.characterType) : "";
    },
    // i18n.language: character names are translated.
    [identityPlayers, playerByIndex, pins.source, i18n.language]
  );

  // Duplicate parent labels carry their owner's character, only on collision —
  // the same rule the chart legend applies to duplicate player names.
  const abilityRowLabels = useMemo(
    () => qualifiedAbilityLabels(rows, labelForAbility, abilityQualifier),
    [rows, labelForAbility, abilityQualifier]
  );

  const isStatusMetric = metric.labelKind("players") === "status";
  const statusRowKind = statusRowKindFor(pins.ability, hostility);

  // A descriptor that can produce more than one shape of row at one level says
  // so on the rows themselves (`MetricRow.kind`). Every row of a table shares a
  // shape, so the first of them settles it for the header too.
  const declaredKind = rows[0]?.kind;

  // What a row's label and its icon are BOTH resolved against. One value rather
  // than the same expression in each callback: the two must never disagree, or
  // a row pairs one kind's name with another kind's art.
  const rowKind = declaredKind ?? (isStatusMetric ? statusRowKind : metric.labelKind(level));

  // One colour per slotless status row, shared with the chart bands below so a
  // row and its band can never disagree.
  const rowColors = useMemo(() => (isStatusMetric ? statusRowColors(rows) : null), [isStatusMetric, rows]);

  // The effects table's provenance (spec §3): each row's cause class as a
  // SOURCE cell, and the rows grouped into titled sections ordered
  // Skill → Sigil/Trait → Field → Unknown. Effect level only — a holder row
  // is one actor, not a cause — and the sections are visual grouping alone.
  const effectLevel = isStatusMetric && !isStatusPin(pins.ability);

  // A cause is classed `skill` only when a name actually resolves for it —
  // through the row's own casters, the same pipeline the labels use.
  const classOfRow = useCallback(
    (row: MetricRow) =>
      causeClassOfKey(row.key, (causeId) => {
        const candidates = causeCandidates.get(row.key) ?? [];
        // The SAME four rungs the label uses. A row named "Guardpoint" filing
        // under Unknown would be the section and the label disagreeing about
        // the same row.
        const casterAction = casterActionOf(intervalsByPinKey.get(row.key) ?? []);
        const classHash = statusKeyParts(row.key)?.classHash ?? null;
        return (
          causeNameFor(
            causeId,
            (cause) => causeSkillName(candidates, cause),
            () => (casterAction === null ? "" : causeSkillName(candidates, casterAction)),
            () => statusClassName(classHash, t)
          ) !== ""
        );
      }),
    // i18n.language: the skill tables the resolution reads are translated.
    [causeCandidates, intervalsByPinKey, t, i18n.language]
  );

  const shownRows = useMemo(
    () => (effectLevel ? withProvenance(rows, classOfRow, (cls) => t(CAUSE_CLASS_LABEL_KEY[cls])) : rows),
    [effectLevel, rows, classOfRow, t]
  );

  const sectionLabelOf = useCallback((row: MetricRow) => t(CAUSE_CLASS_LABEL_KEY[classOfRow(row)]), [classOfRow, t]);

  // The art beside a row's name, by the same discriminator the name uses, so
  // a row can never pair one kind's name with another kind's icon. Undefined
  // is the honest answer for most of what has none: combo actions are not
  // ability casts, `actor:` holder rows index no spawn, and only the boss
  // roster has portraits at all (see enemyIcon.ts).
  const rowIconUrl = useCallback(
    (row: MetricRow): string | undefined => {
      // A self-naming row depicts nothing (see `MetricRow.labelKey`); the
      // ability join below would answer with whichever art its fallback picks.
      if (row.labelKey) return undefined;
      // The row's own kind wins, exactly as in `renderLabel` — the two share
      // one discriminator so a row can never pair one kind's name with
      // another kind's art.
      const kind = row.kind ?? rowKind;
      if (kind === "status") {
        const statusId = statusIdOfKey(row.label);
        return statusId === null ? undefined : statusIconUrl(statusId);
      }
      if (kind === "player") {
        const character = playerByIndex.get(Number(row.label))?.player.characterType;
        return typeof character === "string" ? characterIconUrl(character) : undefined;
      }
      if (kind === "target") {
        const segment = targetRowSegment(row.label);
        return segment === null ? undefined : enemyIconUrl(targetEntries[segment]?.enemyType ?? null);
      }
      // An enemy TYPE row carries the type itself, so it needs no spawn to look
      // one up through.
      if (kind === "enemy") return enemyIconUrl(parseEnemyRow(row.label));
      // A taken row is an enemy's attack, so it wears the attacker's portrait.
      if (kind === "takenAttack") {
        const parts = takenAttackRowParts(row.label);
        return parts ? enemyIconUrl(parts.enemyType) : undefined;
      }
      return abilityRowIconUrl(row.label, identityPlayers, playerByIndex.get(pins.source ?? -1)?.player);
    },
    [rowKind, playerByIndex, targetEntries, identityPlayers, pins.source]
  );

  const renderLabel = useCallback(
    (row: MetricRow) => {
      // A row that names itself (see `MetricRow.labelKey`) resolves against
      // nothing: it is not an ability, a player or an effect, and sending its
      // sentinel through one of those joins would print that join's guess.
      if (row.labelKey) return t(row.labelKey, row.labelParams);
      // The row's own kind wins — the groups path declares one per row — and
      // the table-level discriminator stands in for the legacy descriptors.
      const kind = row.kind ?? rowKind;
      // Effect names come from status.tbl via the generated `statuses` bundle;
      // the ~90 internal statuses the game never names answer empty and fall
      // back to "Effect <id>". The cause resolves through `causeSkillName`,
      // which bridges the effect-entry id at `+0x4c` to the acting skill.
      const name =
        kind === "status"
          ? statusDisplayLabel(row.label)
          : kind === "player"
            ? labelForSource(Number(row.label))
            : kind === "target"
              ? targetRowLabel(row.label, labelForTarget)
              : kind === "enemy"
                ? translateEnemyType(parseEnemyRow(row.label))
                : kind === "takenAttack"
                  ? takenAttackLabel(row.label)
                  : abilityRowLabels.get(row.key) ?? labelForAbility(row.label);
      const icon = rowIconUrl(row);
      if (!icon) return name;
      return (
        <>
          <img className="analysis-row-icon" src={icon} alt="" />
          {name}
        </>
      );
    },
    [
      t,
      rowKind,
      labelForSource,
      labelForTarget,
      labelForAbility,
      takenAttackLabel,
      statusDisplayLabel,
      rowIconUrl,
      abilityRowLabels,
    ]
  );

  // A row click pins its dimension through the machine's transition, so the
  // `by` override drops and the derived default advances — WCL's behavior.
  // The payload still arrives in the legacy `SelectorPins` wire shape.
  const handlePin = useCallback(
    (next: Partial<SelectorPins>) => {
      if (next.source !== undefined && next.source !== null) {
        setState(pinRow(state, { dim: "source", value: next.source }));
      } else if (next.targets !== undefined && next.targets.length > 0) {
        setState(pinRow(state, { dim: "target", value: next.targets[0] }));
      } else if (next.ability !== undefined && next.ability !== null) {
        setState(pinRow(state, { dim: "ability", value: next.ability }));
      }
    },
    [state, setState]
  );

  // The selector bar hands back whole pin sets. A change per dimension routes
  // through the same transitions a row click uses: an addition pins (and
  // advances the default), a removal only clears its own dimension.
  const handlePinsChange = useCallback(
    (next: SelectorPins) => {
      const target = next.targets.length > 0 ? next.targets[0] : null;
      let draft = state;
      if (next.source !== state.source) {
        draft = next.source === null ? clearPin(draft, "source") : pinRow(draft, { dim: "source", value: next.source });
      }
      if (target !== state.target) {
        draft = target === null ? clearPin(draft, "target") : pinRow(draft, { dim: "target", value: target });
      }
      if (next.ability !== state.ability) {
        draft =
          next.ability === null ? clearPin(draft, "ability") : pinRow(draft, { dim: "ability", value: next.ability });
      }
      if (draft !== state) setState(draft);
    },
    [state, setState]
  );

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
            resolvePlayerColor(palette, playerData, playerByIndex.get(event.actorIndex)?.slot ?? 0, 0)
          : SBA_MARKER_COLOR,
      label: t(MARKER_LINE_KEY[event.kind], { name: labelForSource(event.actorIndex) }),
    }));
  }, [deathEvents, sbaEvents, statusWindow, palette, playerData, playerByIndex, labelForSource, t]);

  const rowColor = useCallback(
    (row: MetricRow) => {
      if (row.colorSlot < 0) {
        // An ENEMY row — a spawn or a type — takes its own actor colour, the
        // same one the chart band above it and the dropdown beside it take.
        // Before this every enemy row was the neutral ink, which said nothing
        // about which enemy it was and made the table the one place in the
        // view where a boss had no identity.
        //
        // Ahead of the status colours, and it cannot steal from them: an
        // effect row's key is `status:`, which names no actor at all.
        const actor = keyColor(row.key, colorContext);
        if (actor !== undefined) return actor;
        return rowColors?.get(row.key) ?? "var(--an-ink-3)";
      }
      // Re-resolve through the identity party: a scoped fetch renumbers slots,
      // so the descriptor's colorSlot can point at the wrong player.
      const key = row.key.startsWith("player:") ? Number(row.key.slice("player:".length)) : pins.source;
      const slot = playerByIndex.get(key ?? -1)?.slot ?? row.colorSlot;
      return resolvePlayerColor(palette, playerData, slot, 0);
    },
    [palette, playerData, playerByIndex, pins.source, rowColors, colorContext]
  );

  // The rule itself lives in cardSections.ts; the view only supplies the name
  // and colour lookups that keep it a pure function.
  const sectionLabels = useMemo(
    () => ({
      // With an owner (a player card decomposing that player's own breakdown),
      // the key is named against THEIR table first — action ids collide across
      // characters, and the party-order scan named Id's own 120 with Eustace's
      // "Grade 1 Shot" on the hover card.
      ability: (key: string, owner?: ComputedPlayerState) =>
        owner ? abilityLabelFor(key, identityPlayers, getSkillName, owner) : labelForAbility(key),
      enemy: (type: EnemyType) => translateEnemyType(type),
      source: labelForSource,
      // The player's OWN party colour, resolved through the identity party so a
      // scoped fetch's renumbered slots cannot recolour them mid-drill.
      sourceColor: (index: number) => resolvePlayerColor(palette, playerData, playerByIndex.get(index)?.slot ?? 0, 0),
      character: translateCharacterType,
      // The same art the rows above the card show, resolved the same way, so
      // hovering a row cannot show its members under different pictures.
      abilityIcon: (key: string, owner?: ComputedPlayerState) => abilityRowIconUrl(key, identityPlayers, owner),
      enemyIcon: enemyIconUrl,
      sourceIcon: (index: number) => {
        const character = playerByIndex.get(index)?.player.characterType;
        return typeof character === "string" ? characterIconUrl(character) : undefined;
      },
      // The SAME spawn naming (and art) the table's target rows resolve
      // through, so a card's "#2" can never name a different spawn.
      target: labelForTarget,
      targetIcon: (segment: number) => enemyIconUrl(targetEntries[segment]?.enemyType ?? null),
    }),
    [
      labelForAbility,
      identityPlayers,
      labelForSource,
      palette,
      playerData,
      playerByIndex,
      labelForTarget,
      targetEntries,
    ]
  );

  // The enemy-side cards' lookups: the same ones the friendly card already
  // injects, plus the enemy-attack namer the taken tab uses. Extended rather
  // than restated so an ability, a player and their colour cannot be named one
  // way on the friendly side and another on the enemy side.
  const hostilityLabels = useMemo(
    () => ({ ...sectionLabels, attack: labelForTakenAttack }),
    [sectionLabels, labelForTakenAttack]
  );

  // Which card explains a row is DECLARED per (grouping, side) — see
  // `MetricCapabilities.cardKind` — and routed by `rowCardSectionsFor`, the
  // pure dispatch the presence test exercises. The view only supplies the
  // name/colour lookups and the scoped party.
  const rowSections = useCallback(
    (row: MetricRow) =>
      rowCardSectionsFor({
        cardKind: caps.cardKind(spec.groupBy, hostility),
        groupBy: spec.groupBy,
        row,
        level,
        players,
        pins,
        targetEntries,
        color: rowColor(row),
        labels: hostilityLabels,
        card: metric.card,
      }),
    [caps, spec.groupBy, hostility, level, players, pins, targetEntries, rowColor, hostilityLabels, metric]
  );
  // What the plot shows follows the metric tabs. Each metric brings its own
  // bucketed series from the base load, so switching tabs never refetches.
  const chartMetric = useMemo(() => {
    if (metricKey === "stun") {
      return {
        labelKey: "ui.logs.chart-stun-label",
        source: stunChart,
        len: chartLen,
        // Same smoothing as DPS: both are per-second rates off the same buckets.
        smoothing: DPS_SMOOTHING_WINDOW,
        scale: 1,
        format: "amount" as const,
      };
    }
    if (metricKey === "sba") {
      return {
        labelKey: "ui.logs.chart-sba-label",
        source: sbaChart,
        len: sbaChartLen,
        // A gauge level, not a rate: smoothing would round off the discharge
        // that IS the reading. Stored in tenths of a percent.
        smoothing: 1,
        scale: 0.1,
        format: "percent" as const,
      };
    }
    if (metricKey === "taken") {
      return {
        labelKey: "ui.logs.chart-taken-label",
        source: takenChart,
        len: chartLen,
        // Same smoothing as DPS: incoming damage per second off the same buckets.
        smoothing: DPS_SMOOTHING_WINDOW,
        scale: 1,
        format: "amount" as const,
      };
    }
    return {
      labelKey: "ui.logs.chart-dps-label",
      source: dpsChart,
      len: chartLen,
      // Same trailing moving average the classic view smooths with, so the
      // same fight draws the same line in both.
      smoothing: DPS_SMOOTHING_WINDOW,
      scale: 1,
      format: "amount" as const,
    };
  }, [metricKey, dpsChart, stunChart, takenChart, chartLen, sbaChart, sbaChartLen]);

  // Display name for one chart band, off the same row-key grammar the table's
  // rows carry — a band and the row it decomposes must read identically.
  const bandLabelFor = useCallback(
    (key: string): string => {
      if (key === "other") return t("ui.logs.chart-other-label");
      // The drilled SBA chart's non-skill bands: named through the SAME namer
      // the SBA table names its `source:` rows with, so a band and the row it
      // sits above cannot read differently. Checked before `skill:` because the
      // unattributed remainder wears a `skill:` key it has no ability for.
      const cause = sbaCauseLabel(key);
      if (cause !== null) return t(cause.labelKey, cause.labelParams);
      if (key.startsWith("player:")) return labelForSource(Number(key.slice("player:".length)));
      if (key.startsWith("target:")) return labelForTarget(Number(key.slice("target:".length)));
      if (key.startsWith("enemy:")) return translateEnemyType(parseEnemyRow(key.slice("enemy:".length)));
      if (key.startsWith("taken:")) return takenAttackLabel(key.slice("taken:".length));
      const ability = skillKeyPayload(key);
      if (ability !== null) return labelForAbility(ability);
      return key;
    },
    // i18n.language: every branch produces a translated name.
    [t, labelForSource, labelForTarget, takenAttackLabel, labelForAbility, i18n.language]
  );

  // The groups path's source grouping on the friendly side is the per-player
  // chart the base load used to own — one LINE per player in party colours,
  // not a stacked overlay — narrowed by whatever the query filtered, which is
  // exactly what the old scoped per-player rebuild provided.
  const groupPlayerSeries = useMemo(() => {
    if (!groupsPath || spec.groupBy !== "source" || hostility !== "friendly") return null;
    const byIndex: Record<number, number[]> = {};
    for (const aggregate of groups) {
      if (aggregate.key.kind === "player") byIndex[aggregate.key.index] = aggregate.series;
    }
    return Object.keys(byIndex).length > 0 ? byIndex : null;
  }, [groupsPath, spec.groupBy, hostility, groups]);

  // Every other grouping (and the whole enemy side) stacks the aggregates'
  // bands — the same series whose sums the table's rows report, so the chart
  // and the table cannot disagree.
  const groupOverlay = useMemo(() => {
    if (!groupsPath || (spec.groupBy === "source" && hostility === "friendly")) return null;
    if (groups.length === 0) return null;
    // The same cap the query asked for: the backend keeps every row for the
    // table and appends one `other` band summing the tail, so the chart has to
    // slice or it stacks that tail twice.
    return groupBandsFor(groups, GROUP_TOP_N).map(({ key, values }) => ({ key, label: bandLabelFor(key), values }));
  }, [groupsPath, spec.groupBy, hostility, groups, bandLabelFor]);

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
      bucketMs: DPS_BUCKET_MS,
      len: chartLen,
      holderOf: (interval) =>
        hostility === "enemy"
          ? {
              key: enemyHolderKey(interval),
              label:
                interval.targetSegment === null ? String(interval.actorIndex) : labelForTarget(interval.targetSegment),
            }
          : { key: `player:${interval.actorIndex}`, label: labelForSource(interval.actorIndex) },
    });
    return series.length > 0 ? series : null;
  }, [isStatusMetric, statusIntervals, pins, chartLen, hostility, labelForTarget, labelForSource, identityPlayers]);

  // The top-level aura chart: no effect pinned, so the effects THEMSELVES are
  // the series — the top 8 by uptime (the table's own ranking), Y = holders
  // with the effect active. Same polarity, side and pin narrowing as the
  // table rows (`statusTabRows`), so the chart draws the rows above it.
  //
  // `statusIntervals`, not `windowedIntervals`, for the same reason as
  // `statusSeries`: the parent crops the chart, and cropping twice would
  // shorten the series against a chart that is already the window.
  const effectSeries = useMemo(() => {
    if (!isStatusMetric || isStatusPin(pins.ability)) return null;
    const series = buildEffectSeries({
      // The one composition the table rows use (`statusTabRows`), so the plot
      // cannot draw a different set of effects from the rows underneath it.
      intervals: narrowedStatusIntervals({
        intervals: statusIntervals,
        slots: slotsOf(identityPlayers),
        hostility,
        harmful: metricKey === "debuffs",
        pins,
      }),
      bucketMs: DPS_BUCKET_MS,
      len: chartLen,
      // The same cap as the group bands — both feed the eight-colour palette.
      topN: GROUP_TOP_N,
      labelOf: statusDisplayLabel,
      holderKeyOf: (interval) => (hostility === "enemy" ? enemyHolderKey(interval) : `player:${interval.actorIndex}`),
    });
    return series.length > 0 ? series : null;
  }, [isStatusMetric, pins, identityPlayers, statusIntervals, hostility, metricKey, chartLen, statusDisplayLabel]);

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
    return abilityBands(bands, GROUP_TOP_N, bandLabelFor, pins.ability === null ? "group" : "action");
  }, [caps.dataPath, spec.groupBy, pins.source, pins.ability, scopedAbilitySeries, bandLabelFor]);

  // Which series the per-player chart draws. identityPlayers, not players: these
  // charts hold the whole party, so a pin must not drop curves from the plot.
  //
  // The exception is a pinned source on a metric with no decomposition to
  // draw (stun, SBA): showing the whole party there answers a question nobody
  // asked, and narrowing to the pinned player is the most the data supports.
  const chartIndexes = useMemo(() => {
    const everyone = identityPlayers.map((player) => player.index);
    if (statusSeries || effectSeries || groupOverlay || abilitySeries || groupPlayerSeries || pins.source === null)
      return everyone;
    return everyone.filter((index) => index === pins.source);
  }, [identityPlayers, statusSeries, effectSeries, groupOverlay, abilitySeries, groupPlayerSeries, pins.source]);

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
    effectSeries,
    groupOverlay,
    abilitySeries,
    groupPlayerSeries,
    groupsPath,
    groupBy: spec.groupBy,
    hostility,
    metricKey,
    level,
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
        ? { admitted: admittedBucketsOf(maskWindows, chartInputs.len, DPS_BUCKET_MS) }
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
          text: (span, amount) => {
            const enemy = span.kind === "break" ? breakEnemyOf(span.actorIndex, span) : null;
            const kind = t(WINDOW_LABEL_KEY[span.kind]);
            return t(amount === null ? "ui.logs.chart-window-tooltip" : "ui.logs.chart-window-tooltip-amount", {
              kind: enemy === null ? kind : t("ui.logs.chart-window-break-of", { kind, enemy }),
              range: `${millisecondsToElapsedFormat(span.startMs)}–${millisecondsToElapsedFormat(span.endMs)}`,
              duration: t("ui.logs.window-chip-duration", { seconds: Math.round((span.endMs - span.startMs) / 1000) }),
              amount: amount === null ? "" : humanizeNumber(amount),
            });
          },
        }
      ),
    // i18n.language: every label in the line is translated.
    [chartWindows, statusWindow, format, chartInputs, breakEnemyOf, t, i18n.language]
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
        ? overlay.map((series, position) => ({
            name: series.key,
            label: series.label,
            partySlotIndex: position,
            // An ACTOR band takes its actor's own colour — the same one its row
            // in the table and its entry in the dropdown take, so one enemy is
            // one colour wherever it appears. The positional palette stays for
            // the bands that name no actor: an ability drill, a taken-attack
            // row, the `other` remainder. Those have no identity to be
            // consistent about, and position is the honest ordering for them.
            color:
              keyColor(series.key, colorContext) ??
              mantineColorVar(HP_SERIES_COLORS[position % HP_SERIES_COLORS.length]),
          }))
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
                  player_label_template
                ),
                partySlotIndex: player.partyIndex,
                color: colors[player.partyIndex % colors.length] ?? PLAYER_COLORS[0],
              })),
          ],
    [overlay, identityPlayers, chartIndexes, labelForSource, colors, player_label_template, withTotal, t, colorContext]
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
    return excluded.length === 0 ? undefined : excluded.map((band) => ({ color: "var(--an-ink-3)", band }));
  }, [maskWindows, statusWindow]);

  // The chart IS the window: committing does not shade the rest of the fight,
  // it stops drawing it. Sliced client-side from the base load — the reparse
  // that `range` triggers is for the table, which needs figures no bucketed
  // series can give.
  const shownChartData = useMemo(
    () => (range === null ? chartData : chartData.slice(range[0], range[1] + 1)),
    [chartData, range]
  );

  // The dev-only readout: the whole machine state plus what the spec resolved
  // it to — one JSON line a report can paste, replacing the hand-kept
  // key=value formatter the machine made redundant.
  const debugChart = useMemo(
    () => JSON.stringify({ state, groupBy: spec.groupBy, chart: spec.chart.source, fetch: spec.fetch !== null }),
    [state, spec]
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

  if (!shownEncounter) return null;

  const windowLabel = range === null ? null : `${bucketLabel(range[0])} – ${bucketLabel(range[1])}`;
  const fullLabel = bucketLabel(Math.max(0, chartLen - 1));

  return (
    <Box className="analysis analysis-tokens">
      {/* Above everything, on its own row: the way back to Classic. It is not
          part of the selector bar below because it does not select anything —
          it replaces the whole body, so it sits outside what it would replace.
          Padded like ActorBar, since the view is full-bleed and nothing else
          holds its children off the window edge. */}
      <Box style={{ display: "flex", justifyContent: "flex-end", padding: "10px 16px" }}>
        <ViewModeToggle />
      </Box>

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
            value={onEvents ? EVENTS_TAB : TABLE_TAB}
            onChange={(value) =>
              // Leaving Events clears the param rather than storing "table":
              // the table body is the default, and a default in the URL is
              // noise. The metric the table was last on is untouched either
              // way — it lives in the machine, not here.
              setTab(value === EVENTS_TAB ? EVENTS_TAB : null)
            }
          />
        }
      />

      {/* Above the metric tabs, where Warcraft Logs puts it: rendering it below
          the switcher shifted every control under it each time the metric
          changed. Only metrics that declare `supportsHostility` can operate it
          — see HostilityToggle's `disabled`. */}
      <Box style={{ padding: "8px 16px 0" }}>
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
        format={format}
        stacked={stacked}
        onScope={handleScope}
        fromLabel={range === null ? bucketLabel(0) : bucketLabel(range[0])}
        toLabel={range === null ? fullLabel : bucketLabel(range[1])}
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
      />

      {/* Dev builds only, the same guard the Debug tab uses. */}
      {import.meta.env.DEV && <DebugBar search={search} chart={debugChart} />}

      {/* The Windows strip: the battle-window filter's UI, on every tab —
          unlike the aura strips it needs no pin to anchor it. Selecting a
          chip also COMMITS the scrub window to the selection's bucket hull —
          the chart zooms to the window through the same mechanism a drag
          uses, so the readout, the uptime denominators and the fetches all
          follow. Clearing the chip clears that zoom with it; a stale index
          resolves to no hull and leaves the scrub alone. */}
      <WindowStrip
        chips={windowFilterChips}
        onSelect={(win) => {
          const scrub = windowFilterScrubRange(selectedChartWindows(chartWindows, win), DPS_BUCKET_MS);
          const next = windowFilterTransition(state, win);
          setState(scrub === null ? next : windowTransition(next, scrub));
        }}
        onClear={() => setState(windowTransition(windowFilterTransition(state, null), null))}
      />

      {/* The Auras Filter (spec: between chart and table). Each strip exists
          only while its actor pin does — AuraStrip renders nothing for an
          empty chip list — and one aura is active at a time: selecting on
          either strip replaces the other's selection. */}
      {caps.supportsAuraFilter && (
        <>
          <AuraStrip
            titleKey="ui.logs.aura-source-title"
            chips={sourceAuraChips}
            onSelect={(aura) => setState(auraTransition(state, aura))}
            onClear={() => setState(auraTransition(state, null))}
          />
          <AuraStrip
            titleKey="ui.logs.aura-target-title"
            chips={targetAuraChips}
            onSelect={(aura) => setState(auraTransition(state, aura))}
            onClear={() => setState(auraTransition(state, null))}
          />
        </>
      )}

      {/* The ONE block the view switch swaps: the metric's figures, or the raw
          events behind them. Everything above is the same in both. */}
      {onEvents ? (
        <EventsTab
          id={id}
          metric={metricKey}
          hostility={hostility}
          pins={eventPins}
          probes={eventProbes}
          labels={eventLabels}
        />
      ) : (
        <Box style={{ padding: "4px 16px 14px" }}>
          <MetricTable
            rows={shownRows}
            // The SOURCE header rides the same `effectLevel` condition that
            // prepends the cells, so the two can never disagree — deliberately
            // NOT declared on the descriptor's columnKeys: a `by` regroup can
            // move groupBy without moving the rows off the effect level, and
            // the PIN (not the grouping) is what statusRows keys the level on.
            columnKeys={effectLevel ? ["ui.logs.buff-source", ...spec.table.columnKeys] : spec.table.columnKeys}
            onPin={handlePin}
            renderLabel={renderLabel}
            rowColor={rowColor}
            rowSections={rowSections}
            rowChildren={rowChildren}
            cardAmount={metric.card}
            timelineMs={fightDurationMs}
            sectionLabel={effectLevel ? sectionLabelOf : undefined}
            // The resolver names the honest empty states (see `emptyKeyFor`).
            // The aura tabs' key means "this log never recorded status events",
            // so it applies only when the fight truly has no intervals — with
            // intervals in hand an empty status table IS about the pins, and
            // the table's own default says so.
            emptyKey={isStatusMetric && statusIntervals.length > 0 ? undefined : spec.table.emptyKey}
            rowsLabelKey={spec.table.rowsLabelKey}
          />
        </Box>
      )}
    </Box>
  );
};
