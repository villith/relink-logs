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
  AbilityChartSeries,
  ActionType,
  CharacterType,
  ComputedPlayerState,
  EncounterState,
  EnemyType,
  SelectionFact,
  StatusInterval,
  TakenChartSeries,
  TargetChartSeries,
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
import { rowLevelFor } from "../deriveRows";
import { buffs, enemyHolderKey, heldByRoster, slotsOf } from "../metrics/buffs";
import { damageDone, parseEnemyRow } from "../metrics/damageDone";
import { damageTaken, takenAttackNameKey, takenAttackRowParts } from "../metrics/damageTaken";
import { debuffs } from "../metrics/debuffs";
import { sba } from "../metrics/sba";
import { stun } from "../metrics/stun";
import type { Hostility, MetricDescriptor, MetricRow } from "../metrics/types";
import { deriveSelectorOptions, type SelectorPins } from "../selectorOptions";
import { toBands } from "../statusBands";
import { clipToWindow, isStatusPin, statusPinKey } from "../statusUptime";
import { buildTargetLabels } from "../targetLabels";
import { useSelectorParams } from "../useSelectorParams";

import { DebugBar } from "./DebugBar";
import { DpsChart } from "./DpsChart";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTable } from "./MetricTable";
import { MetricTabs, type MetricTab } from "./MetricTabs";
import { PinBar } from "./PinBar";
import { QuestSummary } from "./QuestSummary";
import { abilityLabelFor } from "./abilityLabel";
import "./analysis.css";
import { cardSectionsFor } from "./cardSections";
import { buildSeriesPoints } from "./chartSeries";
import { formatChartDebug } from "./debugSummary";
import { foldAbilityChart, foldTargetChart } from "./drillSeries";
import { enemyDealtCardSectionsFor, enemyReceivedCardSectionsFor } from "./hostilityCardSections";
import { labelSourceOptions, legendLabelFor } from "./legendLabel";
import { identityPartyOf } from "./partyIdentity";
import { abilityRowIconUrl } from "./rowIcon";
import { buildStatusSeries } from "./statusChart";
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
import { takenCardSectionsFor } from "./takenCardSections";
import { useUrlQueryString } from "./useUrlQueryString";

/** The metric switcher's contents, in display order. Adding a metric is adding
 * a descriptor here — the frame itself does not change. */
const METRICS: Record<string, MetricDescriptor> = { damage: damageDone, taken: damageTaken, stun, sba, buffs, debuffs };

/** The switcher's contents, derived from METRICS — each descriptor already
 * carries the label the tab shows, and two lists that must agree is one list
 * too many. Insertion order above is the display order. */
const METRIC_TABS: MetricTab[] = Object.entries(METRICS).map(([value, descriptor]) => ({
  value,
  labelKey: descriptor.labelKey,
}));

/** i18next key naming what a row is, by KIND — for the tables whose rows the
 * level alone does not describe: a status table's effects and the actors
 * holding one, and a damage drill-down that decomposed into enemies or
 * players instead of member skills. */
const KIND_ROWS_LABEL_KEY = {
  status: "ui.logs.rows-by-effect",
  player: "ui.logs.rows-by-player",
  // A debuff holder is an enemy spawn, and a damage row's `enemy` is an enemy
  // type — both read as "Enemy" to the user.
  target: "ui.logs.rows-by-enemy",
  enemy: "ui.logs.rows-by-enemy",
  ability: "ui.logs.rows-by-ability",
  // A taken row is one enemy attack, which still reads as "Ability".
  takenAttack: "ui.logs.rows-by-ability",
} as const;

/** i18next key naming what a row is at each level. */
const ROWS_LABEL_KEY = {
  players: "ui.logs.rows-by-player",
  abilities: "ui.logs.rows-by-ability",
  skills: "ui.logs.rows-by-skill",
} as const;

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
    enemyDealtChart,
    enemyReceivedChart,
    chartLen,
    sbaChart,
    sbaChartLen,
    targetEntries,
    selectionFacts: baseFacts,
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
      enemyDealtChart: state.enemyDealtChart,
      enemyReceivedChart: state.enemyReceivedChart,
      chartLen: state.chartLen,
      sbaChart: state.sbaChart,
      sbaChartLen: state.sbaChartLen,
      targetEntries: state.targetEntries,
      selectionFacts: state.selectionFacts,
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

  const [pins, setPins] = useSelectorParams();
  const [metricKey, setMetricKey] = useState<string>("damage");
  // Which side's holders the status tables show. Independent of the tab:
  // polarity (buff vs debuff) and holder side are two axes, and Warcraft Logs
  // opens BOTH its aura tabs on Friendlies. Pinning Debuffs to the enemy side
  // made the switch look like a consequence of the tab and hid the ailments the
  // party was carrying, which is the first thing a Debuffs tab should answer.
  //
  // Reset per LOG, not per tab: a side chosen on Buffs still means the same
  // thing on Debuffs, so switching tabs must not undo it.
  const [hostility, setHostility] = useState<Hostility>("friendly");
  useEffect(() => setHostility("friendly"), [id]);
  // Committed window as [start, end] second indexes; null = the full fight. The
  // in-flight drag lives inside DpsChart — nothing outside it needs to know
  // about a selection that has not been released yet.
  const [range, setRange] = useState<[number, number] | null>(null);
  // Meter state, facts and drill-down chart re-derived under the current pins
  // and window. Null means "nothing pinned and no window", i.e. the base load
  // already says it.
  const [scoped, setScoped] = useState<{
    state: EncounterState;
    facts: SelectionFact[];
    abilityChart: AbilityChartSeries[];
    targetChart: TargetChartSeries[];
    takenChart: TakenChartSeries[];
    playerChart: Record<number, number[]>;
  } | null>(null);

  // Responses are not ordered with respect to their requests (the command is
  // `#[tauri::command(async)]`), so each one drops itself once superseded.
  // Counted separately from the base load: a pin change must not cancel a load.
  const loadGeneration = useRef(0);
  const scopeGeneration = useRef(0);

  // The base load: the full fight, unpinned. Owns the charts, the party and the
  // quest metadata, none of which a pin changes.
  useEffect(() => {
    const generation = ++loadGeneration.current;
    scopeGeneration.current += 1;
    invoke("fetch_encounter_state", { id: Number(id), options: { filters } })
      .then((result) => {
        if (generation !== loadGeneration.current) return;
        loadFromResponse(result as EncounterStateResponse);
        setRange(null);
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

  // The scoped fetch: everything the selector bar and the window change. Sends
  // `stateOnly` because the charts stay from the base load — the backend still
  // returns selection facts there, so the cascade re-narrows with the window.
  useEffect(() => {
    // A status pin narrows nothing the backend knows about — the request below
    // deliberately sends `abilities: []` for one. Counting it as "pinned"
    // bought a full decompress-and-reparse of the whole log on every buff click
    // whose result was byte-identical to the base load already in the store.
    const pinned =
      pins.source !== null || (pins.ability !== null && !isStatusPin(pins.ability)) || targetSpans.length > 0;
    if (!pinned && range === null) {
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
      },
    })
      .then((result) => {
        if (generation !== scopeGeneration.current) return;
        const response = result as EncounterStateResponse;
        // Normalised here, at the boundary: the Rust binary does not hot-reload,
        // so a frontend ahead of its backend must degrade to "no drill chart"
        // rather than throw on a field the running binary never sends.
        setScoped({
          state: response.encounterState,
          facts: response.selectionFacts ?? [],
          abilityChart: response.abilityChart ?? [],
          targetChart: response.targetChart ?? [],
          takenChart: response.takenAbilityChart ?? [],
          // Present only when a pin narrows the fight with no source pinned;
          // absent on an older binary, which degrades to the base-load chart.
          playerChart: response.dpsChart ?? {},
        });
      })
      .catch((e) => {
        if (generation !== scopeGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, filters, pins.source, pins.ability, pinnedActions, targetSpans, range]);

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
  const level = rowLevelFor(pins);

  // Whether the enemy side is actually on screen. The toggle's value is per LOG,
  // not per tab, so `hostility === "enemy"` alone is not enough: on a tab that
  // cannot switch (SBA, Stun — see HostilityToggle's `disabled`) it stays
  // "enemy" while the friendly table is what renders. One spelling, so the
  // chart, its title, the hover cards and the empty state cannot disagree about
  // which side is showing.
  const enemySide = hostility === "enemy" && metric.supportsHostility === true;

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

  const rows = useMemo(
    () =>
      shownEncounter
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
        : [],
    [
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
    ]
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
      if (rowKind === "status") {
        const statusId = statusIdOfKey(row.label);
        return statusId === null ? undefined : statusIconUrl(statusId);
      }
      if (rowKind === "player") {
        const character = playerByIndex.get(Number(row.label))?.player.characterType;
        return typeof character === "string" ? characterIconUrl(character) : undefined;
      }
      if (rowKind === "target") {
        const segment = targetRowSegment(row.label);
        return segment === null ? undefined : enemyIconUrl(targetEntries[segment]?.enemyType ?? null);
      }
      // An enemy TYPE row carries the type itself, so it needs no spawn to look
      // one up through.
      if (rowKind === "enemy") return enemyIconUrl(parseEnemyRow(row.label));
      // A taken row is an enemy's attack, so it wears the attacker's portrait.
      if (rowKind === "takenAttack") {
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
      // Effect names come from status.tbl via the generated `statuses` bundle;
      // the ~90 internal statuses the game never names answer empty and fall
      // back to "Effect <id>". The cause resolves through `causeSkillName`,
      // which bridges the effect-entry id at `+0x4c` to the acting skill.
      const name =
        rowKind === "status"
          ? statusDisplayLabel(row.label)
          : rowKind === "player"
            ? labelForSource(Number(row.label))
            : rowKind === "target"
              ? targetRowLabel(row.label, labelForTarget)
              : rowKind === "enemy"
                ? translateEnemyType(parseEnemyRow(row.label))
                : rowKind === "takenAttack"
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

  const handlePin = useCallback((next: Partial<SelectorPins>) => setPins({ ...pins, ...next }), [pins, setPins]);

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
    }),
    [labelForAbility, identityPlayers, labelForSource, palette, playerData, playerByIndex]
  );

  // The enemy-side cards' lookups: the same ones the friendly card already
  // injects, plus the enemy-attack namer the taken tab uses. Extended rather
  // than restated so an ability, a player and their colour cannot be named one
  // way on the friendly side and another on the enemy side.
  const hostilityLabels = useMemo(
    () => ({ ...sectionLabels, attack: labelForTakenAttack }),
    [sectionLabels, labelForTakenAttack]
  );

  // Null for a metric with no breakdown behind its rows (SBA is a gauge
  // reading; the status tables' rows are effects and holders). Those tabs used
  // to inherit the damage card and explain a gauge with damage figures.
  //
  // The taken tab has its own card builder: its breakdown is per (attacker,
  // attack), not per skill, so the skill-based sections would explain incoming
  // damage with the player's own abilities.
  const rowSections = useCallback(
    (row: MetricRow) => {
      // Enemy-side rows have their own decompositions, in both directions: the
      // skill-based builder would explain an ENEMY with the party's abilities,
      // which is nonsense whichever tab it happens on.
      if (enemySide) {
        if (metricKey === "damage")
          return enemyDealtCardSectionsFor({ row, players, color: rowColor(row), labels: hostilityLabels });
        if (metricKey === "taken")
          return enemyReceivedCardSectionsFor({ row, players, color: rowColor(row), labels: hostilityLabels });
        // The status tabs' enemy side lists effect uptime, which the damage
        // card cannot decompose — they carry no `card` either way.
        return null;
      }
      if (metricKey === "taken") {
        return takenCardSectionsFor({
          row,
          players,
          color: rowColor(row),
          labels: { attack: labelForTakenAttack, enemy: translateEnemyType, enemyIcon: enemyIconUrl },
        });
      }
      return metric.card
        ? cardSectionsFor({ row, level, players, pins, color: rowColor(row), labels: sectionLabels, card: metric.card })
        : null;
    },
    [enemySide, metricKey, metric, level, players, pins, rowColor, sectionLabels, hostilityLabels, labelForTakenAttack]
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

  // The chart follows the ROW LEVEL: a player row is explained by the party's
  // curves, an ability row by that player's skill groups, a hit row by the
  // targets the ability hit. Null keeps the per-player chart.
  //
  // Damage only. Stun's two capture paths reconcile with max(), which does not
  // decompose per ability, so there is no honest per-ability stun series to
  // draw — the stun tab narrows to the pinned player instead (below) rather
  // than inventing one. SBA is a per-player gauge with no decomposition at all.
  const drill = useMemo(() => {
    if ((metricKey !== "damage" && metricKey !== "taken") || !scoped) return null;
    const owner = playerByIndex.get(pins.source ?? -1)?.player;
    if (!owner) return null;

    // The taken tab drills into what HIT the pinned player, one band per
    // (attacker, attack) — the same grouping as its table rows.
    if (metricKey === "taken") {
      if (level === "players" || scoped.takenChart.length === 0) return null;
      return scoped.takenChart.map((series) => ({
        key: `taken:${JSON.stringify({ enemyType: series.enemyType, actionId: series.actionId })}`,
        label: labelForTakenAttack(series.enemyType, series.actionId),
        values: series.values,
      }));
    }

    if (level === "abilities" && scoped.abilityChart.length > 0) {
      return foldAbilityChart(scoped.abilityChart, owner.characterType, getSkillName);
    }
    if (level === "skills" && scoped.targetChart.length > 0) {
      return foldTargetChart(
        scoped.targetChart,
        (enemyType, instance) => targetLabels.get(targetLabelKey(enemyType, instance)) ?? translateEnemyType(enemyType)
      );
    }
    return null;
    // i18n.language: both folds produce translated labels.
  }, [metricKey, scoped, level, pins.source, playerByIndex, targetLabels, labelForTakenAttack, i18n.language]);

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

  // The enemy-side plot: one stacked band per enemy TYPE, decomposing exactly
  // what the enemy-side table ranks — who was hitting the party on Damage Done,
  // where the party's damage went on Damage Taken. Same `{key, label, values}`
  // shape as the Stacks and drill overlays, so it rides the same path below;
  // the backend already caps it at eight bands.
  //
  // The key is the table's own row key (`enemy:<JSON of the type>`), so a band
  // and the row it decomposes are the same string rather than two spellings of
  // one enemy.
  //
  // Both series come off the BASE load, so they always span the whole fight: a
  // pin does not narrow them, exactly as the taken and enemy-HP charts already
  // behave. The window slice below still applies, so scrubbing crops them.
  const hostilitySeries = useMemo(() => {
    if (!enemySide) return null;
    const source = metricKey === "damage" ? enemyDealtChart : metricKey === "taken" ? enemyReceivedChart : null;
    // Null, not an empty array: the status tabs' enemy side has no per-enemy
    // damage series at all, and a log recorded before damage-taken capture has
    // no dealt series — both must fall through to the chart already drawn
    // rather than blank it.
    if (!source || source.length === 0) return null;
    return source.map((series) => ({
      key: `enemy:${JSON.stringify(series.enemyType)}`,
      label: translateEnemyType(series.enemyType),
      values: series.values,
    }));
    // i18n.language: the labels are translated enemy names.
  }, [enemySide, metricKey, enemyDealtChart, enemyReceivedChart, i18n.language]);

  // Which series the per-player chart draws. identityPlayers, not players: these
  // charts hold the whole party, so a pin must not drop curves from the plot.
  //
  // The exception is a level whose own decomposition is missing — a metric with
  // no drill-down (stun, SBA), or a fight whose bands came back empty. Showing
  // the whole party there answers a question nobody asked; narrowing to the
  // pinned player is the most the data supports. Declared after `drill` because
  // it reads it.
  const chartIndexes = useMemo(() => {
    const everyone = identityPlayers.map((player) => player.index);
    if (drill || pins.source === null) return everyone;
    return everyone.filter((index) => index === pins.source);
  }, [identityPlayers, drill, pins.source]);

  // With no source pinned, an enemy or ability pin still narrows the fight, and
  // the backend rebuilds the per-player series under it — otherwise the plot
  // keeps drawing the whole fight beside a table that has halved. Damage only:
  // it is the only metric a target span can narrow honestly (see
  // `build_scoped_player_chart`).
  const scopedPlayers = useMemo(
    () => (metricKey === "damage" && scoped && Object.keys(scoped.playerChart).length > 0 ? scoped.playerChart : null),
    [metricKey, scoped]
  );

  // Whichever series is drawn INSTEAD of the per-player ones. Stack counts and
  // drill-down bands are the same shape and are consumed identically, so they
  // are one branch here rather than the same ternary spelled out per field.
  // Which of the two it is still matters for smoothing and scale below.
  //
  // The enemy side REPLACES the drill rather than losing to it: the drill bands
  // decompose one pinned player, and beside an enemy table that player's row is
  // not on screen at all. With no enemy series to draw (an old log, or a status
  // tab) the plot keeps whatever the metric's own source is, which is still
  // about the fight rather than about a row nobody can see.
  const overlay = statusSeries ?? (enemySide ? hostilitySeries : drill);

  const chartData: ChartDatapoint[] = useMemo(() => {
    const source = overlay
      ? Object.fromEntries(overlay.map((series) => [series.key, series.values]))
      : scopedPlayers ?? chartMetric.source;
    const keys = overlay ? overlay.map((series) => series.key) : chartIndexes;
    // Drill and scoped series are built over the whole fight from the same
    // per-second buckets, so their own length is authoritative — the base load's
    // chartLen belongs to a different fetch.
    const len = overlay
      ? Math.max(0, ...overlay.map((series) => series.values.length))
      : scopedPlayers
        ? Math.max(0, ...Object.values(scopedPlayers).map((values) => values.length))
        : chartMetric.len;

    return buildSeriesPoints({
      source: source as Record<string, number[]>,
      len,
      keys,
      // A stack count is a LEVEL, not a rate — the same reason the SBA gauge
      // refuses smoothing. Averaged over a trailing window a buff held for one
      // second at four stacks reads as one, and every edge of what is really a
      // step function becomes a ramp.
      smoothing: statusSeries ? 1 : chartMetric.smoothing,
      // The scoped per-player chart is raw damage like `dpsChart`, so its scale
      // is 1 on the damage tab either way — kept explicit rather than accidental.
      scale: overlay || scopedPlayers ? 1 : chartMetric.scale,
    }).map((point, bucket) => ({ ...point, timestamp: bucketLabel(bucket) })) as ChartDatapoint[];
  }, [chartMetric, chartIndexes, overlay, scopedPlayers, statusSeries]);

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
        : identityPlayers
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
    [overlay, identityPlayers, chartIndexes, labelForSource, colors, player_label_template]
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

  // What the plot was actually drawn from, for the dev-only readout. Read off
  // the very values the chart consumed rather than recomputed from the pins, so
  // the line cannot disagree with what is on screen.
  const debugChart = useMemo(
    () =>
      formatChartDebug({
        metric: metricKey,
        level,
        // Same precedence as `overlay` above, including the drill the enemy
        // side suppresses — a readout that disagreed with the plot would be
        // worse than none.
        chart: statusSeries
          ? "stacks"
          : hostilitySeries
            ? "enemy"
            : drill && !enemySide
              ? "drill"
              : scopedPlayers
                ? "scoped"
                : "base",
        series: labels.length,
        len: chartData.length,
        shown: shownChartData.length,
        window: range,
        scoped: scoped !== null,
        spans: targetSpans.length,
        actions: pinnedActions.length,
        bands: chartBands?.length ?? 0,
      }),
    [
      metricKey,
      level,
      statusSeries,
      hostilitySeries,
      enemySide,
      drill,
      scopedPlayers,
      labels,
      chartData,
      shownChartData,
      range,
      scoped,
      targetSpans,
      pinnedActions,
      chartBands,
    ]
  );

  // Indexes arrive relative to the data the chart was given, so a drag while
  // already scoped is relative to the current window — offset it back into
  // whole-fight indexes before committing.
  const handleScope = useCallback(
    (next: [number, number] | null) => {
      if (next === null) {
        setRange(null);
        return;
      }
      const offset = range === null ? 0 : range[0];
      setRange([next[0] + offset, next[1] + offset]);
    },
    [range]
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
          HostilityToggle's `disabled`. */}
      <Box style={{ padding: "8px 16px 0" }}>
        <HostilityToggle value={hostility} onChange={setHostility} disabled={!metric.supportsHostility} />
      </Box>

      <MetricTabs tabs={METRIC_TABS} value={metricKey} onChange={setMetricKey} />

      <PinBar
        options={labelledOptions}
        pins={pins}
        onChange={setPins}
        windowLabel={windowLabel}
        fullLabel={fullLabel}
        onClearWindow={() => setRange(null)}
      />

      <DpsChart
        data={shownChartData}
        labels={labels}
        labelKey={
          statusSeries
            ? "ui.logs.chart-stacks-label"
            : // The enemy side inverts which way the damage flows, so it names
              // both ends explicitly. Reusing the friendly titles would leave
              // the heading unchanged across a toggle that swapped the plotted
              // quantity for its opposite.
              hostilitySeries
              ? metricKey === "damage"
                ? "ui.logs.chart-enemy-dealt-label"
                : "ui.logs.chart-enemy-received-label"
              : // `!enemySide`: the enemy side suppresses the drill (see
                // `overlay`), so titling the plot after it would name bands
                // that are not being drawn.
                drill && !enemySide
                ? metricKey === "taken"
                  ? "ui.logs.chart-taken-drill-label"
                  : DRILL_LABEL_KEY[level]
                : chartMetric.labelKey
        }
        format={statusSeries ? "count" : overlay ? "amount" : chartMetric.format}
        stacked={overlay !== null}
        onScope={handleScope}
        fromLabel={range === null ? bucketLabel(0) : bucketLabel(range[0])}
        toLabel={range === null ? fullLabel : bucketLabel(range[1])}
        bands={chartBands}
      />

      {/* Dev builds only, the same guard the Debug tab uses. */}
      {import.meta.env.DEV && <DebugBar search={search} chart={debugChart} />}

      <Box style={{ padding: "4px 16px 14px" }}>
        <MetricTable
          rows={rows}
          columnKeys={metric.columnKeys(level)}
          onPin={handlePin}
          renderLabel={renderLabel}
          rowColor={rowColor}
          rowSections={rowSections}
          cardAmount={metric.card}
          rowToggle={rowToggle}
          timelineMs={fightDurationMs}
          emptyKey={
            // Every log recorded before the hook emitted status events has none
            // of these, which is not something clearing a pin can fix.
            isStatusMetric && statusIntervals.length === 0
              ? "ui.logs.buffs-empty"
              : // A remote player's SBA breakdown is genuinely empty — attribution
                // only works for the local player — so an empty table here is not
                // a missing pin, it is the honest answer.
                metricKey === "sba" && level !== "players"
                ? "ui.logs.sba-no-breakdown"
                : // Damage Done's enemy side ranks enemies by what they dealt
                  // TO the party, which is the damage-taken stream — a log
                  // recorded before that capture existed has none of it, and
                  // clearing a pin will not bring it back.
                  enemySide && metricKey === "damage"
                  ? "ui.logs.enemy-dealt-empty"
                  : undefined
          }
          // Same discriminator `renderLabel` uses, so the header can never name
          // something other than what the rows under it are.
          rowsLabelKey={
            declaredKind
              ? KIND_ROWS_LABEL_KEY[declaredKind]
              : isStatusMetric
                ? KIND_ROWS_LABEL_KEY[statusRowKind]
                : ROWS_LABEL_KEY[level]
          }
        />
      </Box>
    </Box>
  );
};
