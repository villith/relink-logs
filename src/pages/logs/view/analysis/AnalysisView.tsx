import { Box } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { characterIconUrl } from "@/characterIcon";
import { enemyIconUrl } from "@/enemyIcon";
import { statusIconUrl } from "@/statusIcon";
import { EncounterStateResponse, useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type {
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
import { actionsForPin } from "../abilitySkills";
import { buffs, enemyHolderKey, heldByRoster, narrowedByPins, slotsOf } from "../metrics/buffs";
import { damageDone, parseEnemyRow } from "../metrics/damageDone";
import { damageTaken, takenAttackNameKey, takenAttackRowParts } from "../metrics/damageTaken";
import { debuffs } from "../metrics/debuffs";
import { sba } from "../metrics/sba";
import { isHarmful } from "../metrics/statusPolarity";
import { stun } from "../metrics/stun";
import type { Hostility, MetricDescriptor, MetricRow } from "../metrics/types";
import { deriveSelectorOptions, type SelectorPins } from "../selectorOptions";
import { toBands } from "../statusBands";
import { clipToWindow, isStatusPin, statusPinKey } from "../statusUptime";
import { buildTargetLabels } from "../targetLabels";

import { DebugBar } from "./DebugBar";
import { DpsChart, type StackMode } from "./DpsChart";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTable } from "./MetricTable";
import { MetricTabs, type MetricTab } from "./MetricTabs";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { RegroupStrip } from "./RegroupStrip";
import { abilityLabelFor } from "./abilityLabel";
import "./analysis.css";
import { SBA_MARKER_COLOR, extractMarkers, type ChartMarker } from "./chartMarkers";
import { TOTAL_SERIES_KEY, buildSeriesPoints, withTotalSeries } from "./chartSeries";
import { labelSourceOptions, legendLabelFor } from "./legendLabel";
import { CAPABILITIES, levelFor } from "./machine/capabilities";
import { groupBandsFor, groupRowsFor } from "./machine/groupRows";
import { GROUP_TOP_N, resolveViewSpec } from "./machine/resolve";
import type { MetricKey } from "./machine/state";
import {
  clearPin,
  setHostility as hostilityTransition,
  setMetric as metricTransition,
  pinRow,
  regroup,
  setWindow as windowTransition,
} from "./machine/transitions";
import { useAnalysisState } from "./machine/useAnalysisState";
import { identityPartyOf } from "./partyIdentity";
import { rowCardSectionsFor } from "./rowCardSections";
import { abilityRowIconUrl } from "./rowIcon";
import { buildEffectSeries, buildStatusSeries } from "./statusChart";
import {
  causeCandidatesOf,
  causeNameFor,
  statusIdOfKey,
  statusLabelFor,
  statusRowKindFor,
  targetRowLabel,
  targetRowSegment,
} from "./statusLabel";
import { withStatusOption } from "./statusOption";
import { statusRowColors } from "./statusRowColors";
import { useUrlQueryString } from "./useUrlQueryString";

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

/** What the plot is titled once it decomposes a pinned row, per level. */
const DRILL_LABEL_KEY = {
  players: "ui.logs.chart-dps-label",
  abilities: "ui.logs.chart-drill-ability-label",
  // The chart always stacks by enemy here. The table agrees when the pinned row
  // held one action and decomposed into enemies too, and lists the group's
  // members when it held several — the plot stays the coarser of the two.
  skills: "ui.logs.chart-drill-target-label",
} as const;

/** Bucket index → "M:SS", for the window readout. */
const bucketLabel = (bucket: number) => millisecondsToElapsedFormat(bucket * DPS_BUCKET_MS);

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
    };
  }, [spec.fetch, everySkill, state.window]);
  wireQueryRef.current = wireQuery;
  // The query's JSON identity, for "is a refetch needed at all" below — the
  // object is rebuilt every render, so identity comparison would always refetch.
  const wireQueryKey = useMemo(() => (wireQuery === undefined ? null : JSON.stringify(wireQuery)), [wireQuery]);

  // The scoped fetch: everything the selector bar, the window and the grouping
  // change. Sends `stateOnly` because the charts stay from the base load — the
  // backend still returns selection facts there, so the cascade re-narrows
  // with the window — and carries the group query for the groups-path table.
  useEffect(() => {
    // A status pin narrows nothing the backend knows about — the request below
    // deliberately sends `abilities: []` for one. Counting it as "pinned"
    // bought a full decompress-and-reparse of the whole log on every buff click
    // whose result was byte-identical to the base load already in the store.
    const pinned =
      pins.source !== null || (pins.ability !== null && !isStatusPin(pins.ability)) || targetSpans.length > 0;
    // A regroup with nothing pinned still needs ITS grouping's aggregates —
    // unless the base load already fetched this exact query.
    const needsGroups = wireQueryKey !== null && wireQueryKey !== baseQueryKeyRef.current;
    if (!pinned && range === null && !needsGroups) {
      setScoped(null);
      return;
    }

    const generation = ++scopeGeneration.current;
    invoke("fetch_encounter_state", {
      id: Number(id),
      options: {
        filters,
        targetSpans,
        selection: {
          sourceIndices: pins.source === null ? [] : [pins.source],
          abilities: pinnedActions,
        },
        // Buckets are inclusive at both ends, so the cutoff has to admit all of
        // the last one — `end * 1000` would reparse a window one bucket short.
        ...(range === null ? {} : { fromMs: range[0] * DPS_BUCKET_MS, upToMs: (range[1] + 1) * DPS_BUCKET_MS - 1 }),
        stateOnly: true,
        groupQuery: wireQueryRef.current,
      },
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
        });
      })
      .catch((e) => {
        if (generation !== scopeGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, filters, pins.source, pins.ability, pinnedActions, targetSpans, range, wireQueryKey]);

  // Which aggregates the groups path renders: the scoped fetch's when one is
  // in hand, else the base load's — valid only while the current query IS the
  // one the base load sent (the effect above refetches whenever it is not).
  const groups = scoped?.groups ?? baseGroups;

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
      const { key, params } = takenAttackNameKey(actionId);
      return `${translateEnemyType(enemyType)} — ${t(key, params)}`;
    },
    // i18n.language: enemy names are translated.
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
      return statusLabelFor(key, t, {
        effect: translateStatusName,
        cause: (id) => causeNameFor(id, (cause) => causeSkillName(candidates, cause)),
      });
    },
    // i18n.language: skill and band names are translated.
    [t, causeCandidates, i18n.language]
  );

  const labelledOptions = useMemo(
    () => ({
      sources: labelSourceOptions(options.sources, labelForSource, characterForSource, player_label_template),
      targets: options.targets.map((option) => ({ ...option, label: labelForTarget(Number(option.value)) })),
      abilities: withStatusOption(
        options.abilities.map((option) => ({ ...option, label: labelForAbility(option.value) })),
        pins.ability,
        statusDisplayLabel
      ),
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
    ]
  );

  const metric = METRICS[metricKey] ?? damageDone;

  // Whether the enemy side is actually on screen. `hostility` above is already
  // the EFFECTIVE side (the resolver's rule: a metric with no enemy side reads
  // friendly whatever the URL says), so this one spelling keeps the chart, its
  // title, the hover cards and the empty state agreeing about what is showing.
  const enemySide = hostility === "enemy";

  // The window the status tables measure, in milliseconds from the fight's
  // start. Buckets are inclusive at both ends, so the last one runs to the start
  // of the one after it — the same conversion the scoped fetch and the chart
  // bands use, kept in one place so the three cannot drift.
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
          statusIntervals: windowedIntervals,
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
    windowedIntervals,
    fightDurationMs,
    statusWindow,
    hostility,
  ]);

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
                  : labelForAbility(row.label);
      const icon = rowIconUrl(row);
      if (!icon) return name;
      return (
        <>
          <img className="analysis-row-icon" src={icon} alt="" />
          {name}
        </>
      );
    },
    [t, rowKind, labelForSource, labelForTarget, labelForAbility, takenAttackLabel, statusDisplayLabel, rowIconUrl]
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

  // Which status rows are shaded onto the chart. Component state, not the URL:
  // it is a transient way of reading the plot, unlike the pins, which say what
  // the page is about.
  const [banded, setBanded] = useState<Set<string>>(new Set());

  // A key from the Buffs table means nothing on the Debuffs one, and a band left
  // behind would shade a fight the user never asked about. `id` for the same
  // reason: the route reuses this component across logs, and a status key is a
  // GLOBAL effect id, so a stale band silently matches in the next log and opens
  // it pre-shaded.
  useEffect(() => setBanded(new Set()), [metricKey, id]);

  // Normal | Stacked for the stacks chart. Component-local like the band
  // toggles: a way of reading the plot, not what the page is about. Reset per
  // metric/log for the same stale-state reason as `banded`.
  const [stackMode, setStackMode] = useState<StackMode>("normal");
  useEffect(() => setStackMode("normal"), [metricKey, id]);

  const rowToggle = useCallback(
    (row: MetricRow) => {
      // Only the effect rows: a holder row is one actor's share of a band the
      // effect row already draws.
      if (!isStatusMetric || !isStatusPin(row.key)) return null;
      return {
        shown: banded.has(row.key),
        onToggle: () =>
          setBanded((previous) => {
            const next = new Set(previous);
            if (!next.delete(row.key)) next.add(row.key);
            return next;
          }),
      };
    },
    [isStatusMetric, banded]
  );

  // Chart series, mirroring the classic view's shaping so the same fight draws
  // the same picture in both.
  const colors = useMemo(() => [color_1, color_2, color_3, color_4], [color_1, color_2, color_3, color_4]);

  // The eight-entry palette the chart already draws with, so a player is the
  // same colour in the table as in the plot above it.
  const palette = useMemo(() => [...colors, ...PLAYER_COLORS.slice(4)], [colors]);

  // Death and SBA markers, rebased onto the same window the chart shows and
  // resolved to display form here — the extractor stays pure of names and
  // colours. Deaths wear the dead player's party colour; SBA lines the
  // analysis accent. Unknown actors (enemy deaths) are dropped by the
  // extractor itself.
  const chartMarkers: ChartMarker[] = useMemo(() => {
    const knownActors = new Set(identityPlayers.map((player) => player.index));
    return extractMarkers({ deathEvents, sbaEvents, window: statusWindow, knownActors }).map((event) => ({
      kind: event.kind,
      atMs: event.atMs,
      color:
        event.kind === "death"
          ? resolvePlayerColor(palette, playerData, playerByIndex.get(event.actorIndex)?.slot ?? 0, 0)
          : SBA_MARKER_COLOR,
      label: t(event.kind === "death" ? "ui.logs.marker-death-line" : "ui.logs.marker-sba-line", {
        name: labelForSource(event.actorIndex),
      }),
    }));
  }, [identityPlayers, deathEvents, sbaEvents, statusWindow, palette, playerData, playerByIndex, labelForSource, t]);

  const rowColor = useCallback(
    (row: MetricRow) => {
      if (row.colorSlot < 0) return rowColors?.get(row.key) ?? "var(--an-ink-3)";
      // Re-resolve through the identity party: a scoped fetch renumbers slots,
      // so the descriptor's colorSlot can point at the wrong player.
      const key = row.key.startsWith("player:") ? Number(row.key.slice("player:".length)) : pins.source;
      const slot = playerByIndex.get(key ?? -1)?.slot ?? row.colorSlot;
      return resolvePlayerColor(palette, playerData, slot, 0);
    },
    [palette, playerData, playerByIndex, pins.source, rowColors]
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
      if (key.startsWith("player:")) return labelForSource(Number(key.slice("player:".length)));
      if (key.startsWith("target:")) return labelForTarget(Number(key.slice("target:".length)));
      if (key.startsWith("enemy:")) return translateEnemyType(parseEnemyRow(key.slice("enemy:".length)));
      if (key.startsWith("taken:")) return takenAttackLabel(key.slice("taken:".length));
      if (key.startsWith("skill:")) return labelForAbility(key.slice("skill:".length));
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
    return groupBandsFor(groups).map(({ key, values }) => ({ key, label: bandLabelFor(key), values }));
  }, [groupsPath, spec.groupBy, hostility, groups, bandLabelFor]);

  // The Stacks plot: one stacked series per holder of the pinned effect, so the
  // height is how many stacks the party held at that moment. Only on the status
  // tabs, and only with an effect pinned — an effect row spans every holder and
  // has no single series to draw.
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
      intervals: heldByRoster(statusIntervals, roster, hostility === "friendly"),
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
  }, [
    isStatusMetric,
    statusIntervals,
    pins.ability,
    chartLen,
    hostility,
    labelForTarget,
    labelForSource,
    identityPlayers,
  ]);

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
    const roster = slotsOf(identityPlayers);
    const held = heldByRoster(statusIntervals, roster, hostility === "friendly");
    const polar = held.filter((interval) => isHarmful(interval.statusId) === (metricKey === "debuffs"));
    const series = buildEffectSeries({
      intervals: narrowedByPins(polar, pins, hostility),
      bucketMs: DPS_BUCKET_MS,
      len: chartLen,
      // The same cap as the group bands — both feed the eight-colour palette.
      topN: GROUP_TOP_N,
      labelOf: statusDisplayLabel,
      holderKeyOf: (interval) => (hostility === "enemy" ? enemyHolderKey(interval) : `player:${interval.actorIndex}`),
    });
    return series.length > 0 ? series : null;
  }, [isStatusMetric, pins, identityPlayers, statusIntervals, hostility, metricKey, chartLen, statusDisplayLabel]);

  // Which series the per-player chart draws. identityPlayers, not players: these
  // charts hold the whole party, so a pin must not drop curves from the plot.
  //
  // The exception is a pinned source on a metric with no decomposition to
  // draw (stun, SBA): showing the whole party there answers a question nobody
  // asked, and narrowing to the pinned player is the most the data supports.
  const chartIndexes = useMemo(() => {
    const everyone = identityPlayers.map((player) => player.index);
    if (statusSeries || effectSeries || groupOverlay || groupPlayerSeries || pins.source === null) return everyone;
    return everyone.filter((index) => index === pins.source);
  }, [identityPlayers, statusSeries, effectSeries, groupOverlay, groupPlayerSeries, pins.source]);

  // With no source pinned, an enemy or ability pin still narrows the fight, and
  // the backend rebuilds the per-player series under it — otherwise the plot
  // keeps drawing the whole fight beside a table that has halved. Damage only:
  // it is the only metric a target span can narrow honestly (see
  // `build_scoped_player_chart`).
  // Whichever series is drawn INSTEAD of the per-player ones. Stack counts and
  // group bands are the same shape and are consumed identically, so they are
  // one branch here rather than the same ternary spelled out per field.
  const overlay = statusSeries ?? effectSeries ?? groupOverlay;

  // WHICH of those the plot ended up drawing, recognised from the value itself
  // rather than re-derived from the pins, so the title cannot disagree with
  // what is on screen. "scoped" is the groups path's per-player lines (the
  // query's filters applied); "drill" its stacked bands.
  const chartSource: "base" | "scoped" | "stacks" | "drill" =
    overlay === null
      ? groupPlayerSeries
        ? "scoped"
        : "base"
      : overlay === statusSeries || overlay === effectSeries
        ? "stacks"
        : "drill";

  // The Total series draws exactly where the chart draws independent LINES:
  // the groups path's source grouping on the friendly side (Damage Done and
  // Damage Taken), from either the group series or the base-chart fallback.
  // Stacked charts (drills, and the whole enemy side) already show the total
  // as the stack's height, and a Total series inside a Mantine stacked
  // AreaChart would be ADDED to the stack and double it.
  const withTotal = groupsPath && spec.groupBy === "source" && hostility === "friendly" && overlay === null;

  const chartData: ChartDatapoint[] = useMemo(() => {
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

    const points = buildSeriesPoints({
      source: source as Record<string, number[]>,
      len,
      keys,
      // A stack count is a LEVEL, not a rate — the same reason the SBA gauge
      // refuses smoothing. Averaged over a trailing window a buff held for one
      // second at four stacks reads as one, and every edge of what is really a
      // step function becomes a ramp.
      smoothing: statusSeries || effectSeries ? 1 : chartMetric.smoothing,
      // The group series are raw damage like `dpsChart`, so their scale is 1
      // on the damage tab either way — kept explicit rather than accidental.
      scale: overlay || groupPlayerSeries ? 1 : chartMetric.scale,
    });
    // Summed over ALL fetched series, not the legend-visible ones — the values
    // are baked into the data, so hiding a player later cannot lower the Total.
    return (withTotal ? withTotalSeries(points, keys) : points).map((point, bucket) => ({
      ...point,
      timestamp: bucketLabel(bucket),
    })) as ChartDatapoint[];
  }, [chartMetric, chartIndexes, overlay, groupPlayerSeries, statusSeries, effectSeries, withTotal]);

  const labels: Label = useMemo(
    () =>
      // Drilled in, the bands are one player's own output split up, so the
      // party palette says nothing about them — they take the categorical one
      // the enemy-HP chart already uses, in the same largest-first order.
      overlay
        ? overlay.map((series, position) => ({
            name: series.key,
            label: series.label,
            partySlotIndex: position,
            color: HP_SERIES_COLORS[position % HP_SERIES_COLORS.length],
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
    [overlay, identityPlayers, chartIndexes, labelForSource, colors, player_label_template, withTotal, t]
  );

  // The chart IS the window: committing does not shade the rest of the fight,
  // it stops drawing it. Sliced client-side from the base load — the reparse
  // that `range` triggers is for the table, which needs figures no bucketed
  // series can give.
  const shownChartData = useMemo(
    () => (range === null ? chartData : chartData.slice(range[0], range[1] + 1)),
    [chartData, range]
  );

  // The enabled rows' windows, rebased onto whatever the chart is currently
  // showing. Undefined rather than empty when nothing is banded, so a chart
  // with no bands renders exactly as it did before this existed.
  const chartBands = useMemo(() => {
    if (banded.size === 0) return undefined;

    return [...banded].flatMap((key, index) => {
      // The row's own colour is the normal path; the index fallback only fires
      // for a band whose row scrolled out of the current pin level.
      const color = rowColors?.get(key) ?? mantineColorVar(HP_SERIES_COLORS[index % HP_SERIES_COLORS.length]);
      const held = intervalsByPinKey.get(key) ?? [];
      return toBands(held, statusWindow).map((band) => ({ color, band }));
    });
  }, [banded, intervalsByPinKey, statusWindow, rowColors]);

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
      <QuestSummary
        encounter={shownEncounter}
        questId={questId}
        roomIndex={roomIndex}
        questCompleted={questCompleted}
        questTimer={questTimer}
        imported={imported}
      />

      {/* Above the tabs, where Warcraft Logs puts it: the side is a property of
          the whole view, not of one tab, and rendering it below the switcher
          shifted every control under it each time the tab changed. Only tabs
          that declare `supportsHostility` can operate it — see
          HostilityToggle's `disabled`. Tested `!== true` rather than falsily,
          matching `enemySide` above: one spelling of "this tab has an enemy
          side" keeps the control offering it and the code rendering it from
          disagreeing. */}
      <Box style={{ padding: "8px 16px 0" }}>
        <HostilityToggle
          value={hostility}
          onChange={(side) => setState(hostilityTransition(state, side))}
          disabled={!caps.supportsHostility}
        />
      </Box>

      <MetricTabs
        tabs={METRIC_TABS}
        value={metricKey}
        onChange={(value) => setState(metricTransition(state, value as MetricKey))}
      />

      <PinBar
        options={labelledOptions}
        pins={pins}
        onChange={handlePinsChange}
        windowLabel={windowLabel}
        fullLabel={fullLabel}
        onClearWindow={() => setState(windowTransition(state, null))}
      />

      {/* WCL's "Done By …" strip: the resolved grouping is only a default, and
          this is the override (`by` in the URL). */}
      <RegroupStrip tabs={spec.regroupTabs} onRegroup={(dim) => setState(regroup(state, dim, caps))} />

      <DpsChart
        data={shownChartData}
        labels={labels}
        // Titled after what is DRAWN, never after what the pins would suggest.
        labelKey={
          chartSource === "stacks"
            ? // Pinned, the plot is one effect's stack depths; unpinned it is
              // the effects themselves as holder counts.
              statusSeries !== null
              ? "ui.logs.chart-stacks-label"
              : "ui.logs.chart-effects-label"
            : groupOverlay !== null
              ? // The enemy side inverts which way the damage flows, so both
                // of these name both ends. Reusing the friendly titles would
                // leave the heading unchanged across a toggle that swapped
                // the plotted quantity for its opposite.
                enemySide
                ? metricKey === "damage"
                  ? "ui.logs.chart-enemy-dealt-label"
                  : "ui.logs.chart-enemy-received-label"
                : metricKey === "taken"
                  ? "ui.logs.chart-taken-drill-label"
                  : DRILL_LABEL_KEY[level]
              : chartMetric.labelKey
        }
        // An overlay of any kind plots an amount; the base sources keep their
        // metric's own format (the SBA gauge is a percent).
        format={chartSource === "stacks" ? "count" : groupOverlay !== null ? "amount" : chartMetric.format}
        stacked={overlay !== null}
        onScope={handleScope}
        fromLabel={range === null ? bucketLabel(0) : bucketLabel(range[0])}
        toLabel={range === null ? fullLabel : bucketLabel(range[1])}
        bands={chartBands}
        markers={chartMarkers}
        stackMode={chartSource === "stacks" ? stackMode : undefined}
        onStackModeChange={chartSource === "stacks" ? setStackMode : undefined}
      />

      {/* Dev builds only, the same guard the Debug tab uses. */}
      {import.meta.env.DEV && <DebugBar search={search} chart={debugChart} />}

      <Box style={{ padding: "4px 16px 14px" }}>
        <MetricTable
          rows={rows}
          columnKeys={spec.table.columnKeys}
          onPin={handlePin}
          renderLabel={renderLabel}
          rowColor={rowColor}
          rowSections={rowSections}
          cardAmount={metric.card}
          rowToggle={rowToggle}
          timelineMs={fightDurationMs}
          // The resolver names the honest empty states (see `emptyKeyFor`).
          // The aura tabs' key means "this log never recorded status events",
          // so it applies only when the fight truly has no intervals — with
          // intervals in hand an empty status table IS about the pins, and
          // the table's own default says so.
          emptyKey={isStatusMetric && statusIntervals.length > 0 ? undefined : spec.table.emptyKey}
          rowsLabelKey={spec.table.rowsLabelKey}
        />
      </Box>
    </Box>
  );
};
