import { Box, Divider, SegmentedControl, Stack, Text } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { EncounterStateResponse, useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type { ComputedPlayerState, EncounterState, SelectionFact } from "@/types";
import {
  formatInPartyOrder,
  getSkillName,
  humanizeNumbers,
  millisecondsToElapsedFormat,
  PLAYER_COLORS,
  translateEnemyType,
  translatedPlayerName,
} from "@/utils";

import { abilityKey, parseAbilityKey } from "./abilityKey";
import { rowLevelFor } from "./deriveRows";
import {
  DetailCharts,
  DPS_BUCKET_MS,
  DPS_SMOOTHING_WINDOW,
  HP_SERIES_COLORS,
  type ChartDatapoint,
  type HpDatapoint,
  type Label,
} from "./DetailCharts";
import { MetricTable } from "./MetricTable";
import { damageDone } from "./metrics/damageDone";
import { sba } from "./metrics/sba";
import { stun } from "./metrics/stun";
import type { MetricDescriptor, MetricRow } from "./metrics/types";
import { QuestHeader } from "./QuestHeader";
import { SelectorBar } from "./SelectorBar";
import { deriveSelectorOptions, type SelectorPins } from "./selectorOptions";
import { useSelectorParams } from "./useSelectorParams";

/** The metric switcher's contents, in display order. Adding a metric is adding
 * a descriptor here — the frame itself does not change. */
const METRICS: Record<string, MetricDescriptor> = { damage: damageDone, stun, sba };

/** Bucket index → "M:SS", for the window readout. */
const bucketLabel = (bucket: number) => millisecondsToElapsedFormat(bucket * DPS_BUCKET_MS);

export const AnalysisView = () => {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const filters = useMeterFilters();

  const {
    encounter,
    dpsChart,
    hpChart,
    chartLen,
    targetEntries,
    selectionFacts: baseFacts,
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
      hpChart: state.hpChart,
      chartLen: state.chartLen,
      targetEntries: state.targetEntries,
      selectionFacts: state.selectionFacts,
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
  const [hiddenHpSeries, setHiddenHpSeries] = useState<Set<string>>(new Set());
  // Committed window as [start, end] second indexes; null = the full fight.
  const [range, setRange] = useState<[number, number] | null>(null);
  // Meter state + facts re-derived under the current pins and window. Null
  // means "nothing pinned and no window", i.e. the base load already says it.
  const [scoped, setScoped] = useState<{ state: EncounterState; facts: SelectionFact[] } | null>(null);

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

  // A pinned target is an instance id; the backend filters by SPAN, because the
  // game reuses freed ids across summon waves. Every span that id ever had is
  // sent, so "this enemy" means all of its lifetimes.
  const targetSpans = useMemo(
    () =>
      pins.targetIds.length === 0
        ? []
        : targetEntries
            .filter((entry) => pins.targetIds.includes(entry.id))
            .map((entry) => ({ id: entry.id, startMs: entry.startMs, endMs: entry.endMs })),
    [pins.targetIds, targetEntries]
  );

  // The scoped fetch: everything the selector bar and the window change. Sends
  // `stateOnly` because the charts stay from the base load — the backend still
  // returns selection facts there, so the cascade re-narrows with the window.
  useEffect(() => {
    const pinned = pins.source !== null || pins.ability !== null || targetSpans.length > 0;
    if (!pinned && range === null) {
      setScoped(null);
      return;
    }

    const ability = pins.ability === null ? null : parseAbilityKey(pins.ability);
    const generation = ++scopeGeneration.current;
    invoke("fetch_encounter_state", {
      id: Number(id),
      options: {
        filters,
        targetSpans,
        selection: {
          sourceIndices: pins.source === null ? [] : [pins.source],
          abilities: ability === null ? [] : [ability],
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
        setScoped({ state: response.encounterState, facts: response.selectionFacts ?? [] });
      })
      .catch((e) => {
        if (generation !== scopeGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, filters, pins.source, pins.ability, targetSpans, range]);

  const shownEncounter = scoped?.state ?? encounter;
  const players = useMemo(
    () => (shownEncounter ? formatInPartyOrder(shownEncounter.party) : []),
    [shownEncounter]
  );

  // Cascading options come from the facts for the CURRENT window but with no
  // pin applied — a selector must keep offering what the other pins allow.
  const facts = scoped?.facts ?? baseFacts;
  const options = useMemo(() => deriveSelectorOptions(facts, pins), [facts, pins]);

  // Player labels are looked up by actor index, which is what a pin carries.
  const playerByIndex = useMemo(() => {
    const byIndex = new Map<number, { player: ComputedPlayerState; slot: number }>();
    players.forEach((player) => byIndex.set(player.index, { player, slot: player.partyIndex }));
    return byIndex;
  }, [players]);

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

  // Skill names are per character, so the ability list is named against
  // whichever player is pinned, falling back to the first player who used it.
  const labelForAbility = useCallback(
    (key: string) => {
      const action = parseAbilityKey(key);
      if (!action) return key;
      for (const player of players) {
        const skill = player.skillBreakdown.find((entry) => abilityKey(entry.actionType) === key);
        if (skill) return getSkillName(player.characterType, skill);
      }
      return key;
    },
    // i18n.language: skill names are translated, so a language switch must
    // re-derive them even though it is not read here directly.
    [players, i18n.language]
  );

  const labelForTarget = useCallback(
    (targetId: number) => {
      const entry = targetEntries.find((candidate) => candidate.id === targetId);
      return entry ? `${translateEnemyType(entry.enemyType)} #${entry.instance}` : String(targetId);
    },
    [targetEntries]
  );

  const labelledOptions = useMemo(
    () => ({
      sources: options.sources.map((option) => ({ ...option, label: labelForSource(Number(option.value)) })),
      targets: options.targets.map((option) => ({ ...option, label: labelForTarget(Number(option.value)) })),
      abilities: options.abilities.map((option) => ({ ...option, label: labelForAbility(option.value) })),
    }),
    [options, labelForSource, labelForTarget, labelForAbility]
  );

  const metric = METRICS[metricKey] ?? damageDone;
  const level = rowLevelFor(pins);

  const rows = useMemo(
    () =>
      shownEncounter
        ? metric.rows({ encounter: shownEncounter, partyData: playerData, players, level, pins })
        : [],
    [metric, shownEncounter, playerData, players, level, pins]
  );

  const renderLabel = useCallback(
    (row: MetricRow) =>
      metric.labelKind(level) === "player" ? labelForSource(Number(row.label)) : labelForAbility(row.label),
    [metric, level, labelForSource, labelForAbility]
  );

  const handlePin = useCallback(
    (next: Partial<SelectorPins>) => setPins({ ...pins, ...next }),
    [pins, setPins]
  );

  // Chart series, mirroring the classic view's shaping so the same fight draws
  // the same picture in both.
  const colors = useMemo(() => [color_1, color_2, color_3, color_4], [color_1, color_2, color_3, color_4]);
  const chartData: ChartDatapoint[] = useMemo(() => {
    const points: ChartDatapoint[] = [];
    for (let bucket = 0; bucket < chartLen; bucket++) {
      const point = { timestamp: bucketLabel(bucket) } as ChartDatapoint;
      for (const player of players) {
        const series = dpsChart[player.index] ?? [];
        // Same trailing moving average the classic view smooths with, so the
        // same fight draws the same line in both.
        const from = Math.max(0, bucket - DPS_SMOOTHING_WINDOW + 1);
        let sum = 0;
        for (let i = from; i <= bucket; i++) sum += series[i] ?? 0;
        point[labelForSource(player.index)] = Math.round(sum / (bucket - from + 1));
      }
      points.push(point);
    }
    return points;
  }, [chartLen, players, dpsChart, labelForSource]);

  const labels: Label = useMemo(
    () =>
      players.map((player) => ({
        name: labelForSource(player.index),
        partySlotIndex: player.partyIndex,
        color: colors[player.partyIndex % colors.length] ?? PLAYER_COLORS[0],
      })),
    [players, labelForSource, colors]
  );

  const hpSeries = useMemo(() => {
    // "Boss" = a pool at least a quarter the size of the fight's largest (the
    // only boss signal in the data). Non-boss lines start toggled off.
    const largestMax = hpChart.reduce((acc, series) => Math.max(acc, series.maxHp), 0);
    return hpChart.map((series, index) => ({
      name: `${translateEnemyType(series.enemyType)} #${series.instance}`,
      color: HP_SERIES_COLORS[index % HP_SERIES_COLORS.length],
      defaultHidden: series.maxHp < largestMax / 4,
    }));
  }, [hpChart]);

  const hpData: HpDatapoint[] = useMemo(() => {
    // Forward-fill only INSIDE a pool's lifetime: HP holds its last known value
    // across unhit stretches, but a dead or despawned pool must end rather than
    // drag a flat line to the end of the fight.
    const filled = hpChart.map((series) => {
      const lastReport = series.values.reduce((acc: number, value, i) => (value != null ? i : acc), -1);
      let last: number | null = null;
      return series.values.map((value, i) => {
        if (i > lastReport) return null;
        return value != null ? (last = value) : last;
      });
    });

    const points: HpDatapoint[] = [];
    for (let bucket = 0; bucket < chartLen; bucket++) {
      const point: HpDatapoint = { timestamp: bucketLabel(bucket) };
      hpSeries.forEach((series, seriesIndex) => {
        point[series.name] = filled[seriesIndex][bucket] ?? null;
      });
      points.push(point);
    }
    return points;
  }, [chartLen, hpChart, hpSeries]);

  // Non-boss pools start hidden, re-applied whenever the pool set changes.
  useEffect(() => {
    setHiddenHpSeries(new Set(hpSeries.filter((series) => series.defaultHidden).map((series) => series.name)));
  }, [hpSeries]);

  const toggleHpSeries = useCallback((name: string) => {
    setHiddenHpSeries((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  if (!shownEncounter) return null;

  const windowLabel = range === null ? null : `${bucketLabel(range[0])} – ${bucketLabel(range[1])}`;
  const [total, totalSuffix] = humanizeNumbers(shownEncounter.totalDamage);

  return (
    <Stack gap="sm">
      <QuestHeader
        encounter={shownEncounter}
        questId={questId}
        roomIndex={roomIndex}
        questCompleted={questCompleted}
        questTimer={questTimer}
        imported={imported}
      />

      <Divider />

      <SelectorBar
        options={labelledOptions}
        pins={pins}
        onChange={setPins}
        windowLabel={windowLabel}
        onClearWindow={() => setRange(null)}
      />

      <Box>
        <SegmentedControl
          size="xs"
          value={metricKey}
          onChange={setMetricKey}
          data={Object.entries(METRICS).map(([key, descriptor]) => ({ value: key, label: t(descriptor.labelKey) }))}
        />
      </Box>

      <Text size="xs" c="dimmed">
        {`${total}${totalSuffix}`}
      </Text>

      <MetricTable rows={rows} columnKeys={metric.columnKeys(level)} onPin={handlePin} renderLabel={renderLabel} />

      <Divider />

      <DetailCharts
        data={chartData}
        hpData={hpData}
        hpSeries={hpSeries}
        hiddenHpSeries={hiddenHpSeries}
        onToggleHpSeries={toggleHpSeries}
        labels={labels}
      />
    </Stack>
  );
};
