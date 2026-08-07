import { LineChart } from "@mantine/charts";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Group,
  Menu,
  MultiSelect,
  RangeSlider,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  Calculator,
  Check,
  ClipboardText,
  Minus,
  Plus,
  Warning,
  X,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { t } from "i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useParams } from "react-router-dom";

import { ColumnsPopover } from "@/components/ColumnsPopover";
import { FlaggedGear, traitLine } from "@/components/FlaggedGear";
import { LegalityMark, LegalityPlayerName } from "@/components/LegalityMark";
import { Table as MeterTable } from "@/components/Table";
import { useBackTo } from "@/hooks/useBackTo";
import { useTabParam } from "@/hooks/useTabParam";
import { findingsForSubject } from "@/legality";
import { useChecklistStore } from "@/stores/useChecklistStore";
import { EncounterStateResponse, useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  MeterColumns,
  type CharacterType,
  type ComputedPlayerState,
  type EncounterState,
  type LegalityFinding,
  type PlayerData,
  type SortDirection,
  type SortType,
} from "@/types";
import {
  COMPUTED_SIGIL_ROWS,
  EMPTY_ID,
  OVERMASTERY_EFFECT_IDS,
  PLAYER_COLORS,
  SIGIL_CATEGORY_TARGET,
  SKILLBOARD_CATEGORIES,
  checklistGroupName,
  checklistLevel,
  checklistStatus,
  collectSigilsByCategory,
  collectTraitSources,
  computeCombinedTraits,
  deriveTranscendence,
  exportCharacterDataToClipboard,
  exportFullEncounterToClipboard,
  exportScreenshotToClipboard,
  exportSimpleEncounterToClipboard,
  fillBonusGroups,
  formatBonusAmount,
  formatCharacterLabel,
  formatInPartyOrder,
  formatOvermastery,
  formatSummonBonusValue,
  getPlayerLevel,
  groupBonuses,
  millisecondsToElapsedFormat,
  openDamageCalculator,
  orderedChecklistEntries,
  overmasteryAmount,
  resolvePlayerColor,
  skillboardActivationCost,
  skillboardLayoutFor,
  skillboardNodeMeta,
  summonBonusValue,
  targetLabelKey,
  traitMaxLevel,
  translateAbilityId,
  translateEnemyType,
  translateItemId,
  translateOvermasteryId,
  translateSigilId,
  translateSkillboardBranch,
  translateSkillboardNode,
  translateSummonBonusId,
  translateSummonId,
  translateTraitId,
  translateWeaponId,
  translateWeaponKey,
  translateWrightstoneId,
  translatedPlayerName,
  weaponInnateTraits,
  type BonusAmount,
  type BonusSource,
  type ChecklistEntry,
  type ChecklistStatus,
  type CombinedBonus,
  type CombinedTrait,
  type SigilCategory,
  type SkillboardCategory,
  type TraitSource,
  type WeaponTraitDef,
} from "@/utils";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

// The charts, their geometry constants and the brush shading are shared with
// the analysis view — one implementation, two callers.
import {
  CHART_MARGIN,
  CHART_Y_AXIS_WIDTH,
  ChartTooltip,
  DPS_BUCKET_MS,
  DPS_SMOOTHING_WINDOW,
  DetailCharts,
  HP_SERIES_COLORS,
  OverviewChart,
  brushShade,
  type ChartDatapoint,
  type HpDatapoint,
  type Label,
} from "./DetailCharts";
import { QuestHeader } from "./QuestHeader";
import { buildTargetLabels } from "./targetLabels";

// `formatOvermastery` and friends now live in `@/utils`, shared with the
// Cheat Audit page — see the import above.

// "+1800 (Lvl. 3)" — numeric totals first, with any magnitude-unknown
// (level-only) contributions trailing. Totals arrive in that order already.
const formatBonusTotals = (totals: BonusAmount[]): string => totals.map(formatBonusAmount).join(" ");

const formatPlayerDisplayName = (player: PlayerData, showName: boolean, showLevel: boolean = true): string => {
  const label = formatCharacterLabel(player.characterType, player.displayName, showName);

  return showLevel ? `${label} Lvl. ${getPlayerLevel(player)}` : label;
};

// Returns a string of stars based on the star level.
// ★★★☆☆☆ (3 stars)
// ★★★★★★ (6 stars)
const createWeaponStars = (starLevel: number): string => {
  return "★".repeat(starLevel) + "☆".repeat(6 - starLevel);
};

// Awakening rows repeat the base skill id for most weapons — keep the first
// (non-awakening) occurrence of each trait.
const dedupeWeaponTraits = (traits: WeaponTraitDef[]): WeaponTraitDef[] => {
  const seen = new Set<string>();
  return traits.filter((trait) => !seen.has(trait.id) && (seen.add(trait.id), true));
};

const MemoMeterTable = memo(MeterTable);

// Tooltip grouping for the checklist source breakdown, in display order.
const CHECKLIST_SOURCE_KINDS: { key: TraitSource["kind"]; label: string; translate: (id: number) => string }[] = [
  { key: "sigil", label: "ui.player-sigils", translate: translateSigilId },
  { key: "summon", label: "ui.player-summons", translate: translateSummonId },
  { key: "wrightstone", label: "ui.wrightstone", translate: translateWrightstoneId },
  { key: "weapon", label: "ui.weapon", translate: translateWeaponId },
];

// missing = none, partial = under target, met = exact, over = wasted levels.
const CHECKLIST_DISPLAY: Record<ChecklistStatus, { Icon: PhosphorIcon; color: string }> = {
  missing: { Icon: X, color: "red" },
  partial: { Icon: Warning, color: "orange" },
  met: { Icon: Check, color: "teal" },
  over: { Icon: Warning, color: "yellow" },
};

// One checklist requirement with its status icon and the per-source tooltip
// breakdown; shared by the Sigils and AI checklist groups.
const ChecklistEntryRow = ({
  player,
  traits,
  entry,
}: {
  player: PlayerData;
  traits: CombinedTrait[];
  entry: ChecklistEntry;
}) => {
  const { t } = useTranslation();
  const level = checklistLevel(traits, entry);
  const { Icon, color } = CHECKLIST_DISPLAY[checklistStatus(level, entry.level)];
  const sources = collectTraitSources(player, entry.ids);

  return (
    <Tooltip
      disabled={sources.length === 0}
      color="dark"
      position="top-start"
      label={CHECKLIST_SOURCE_KINDS.filter((kind) => sources.some((source) => source.kind === kind.key)).map((kind) => (
        <Box key={kind.key}>
          <Text size="xs" fw={600}>
            {t(kind.label)}
          </Text>
          {sources
            .filter((source) => source.kind === kind.key)
            .map((source, index) => (
              <Text key={index} size="xs" pl={8}>
                - {kind.translate(source.sourceId)} {t("ui.trait-level", { level: source.level })}
              </Text>
            ))}
        </Box>
      ))}
    >
      <Text size="xs" fw={300} c={color} style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Icon size="0.9rem" weight="bold" /> {translateTraitId(entry.ids[0])}
        <Text span size="xs" ml="auto">
          ({level}/{entry.level})
        </Text>
      </Text>
    </Tooltip>
  );
};

// Tooltip grouping for the combined-bonus source breakdown, in display order.
const BONUS_SOURCE_KINDS: { key: BonusSource["kind"]; label: string }[] = [
  { key: "overmastery", label: "ui.player-overmasteries" },
  { key: "summon", label: "ui.player-summons" },
];

// One combined Builds-tab bonus line (same-effect overmasteries and summon
// bonuses merged), with the per-source breakdown in a tooltip. Effects the
// player has nothing toward render grayed out, without a tooltip.
const BonusRow = ({ bonus }: { bonus: CombinedBonus }) => {
  const { t } = useTranslation();

  if (bonus.sources.length === 0) {
    return (
      <Text size="xs" fs="italic" fw={300} c="dimmed">
        {bonus.name}
      </Text>
    );
  }

  return (
    <Tooltip
      color="dark"
      position="top-start"
      label={BONUS_SOURCE_KINDS.filter((kind) => bonus.sources.some((source) => source.kind === kind.key)).map(
        (kind) => (
          <Box key={kind.key}>
            <Text size="xs" fw={600}>
              {t(kind.label)}
            </Text>
            {bonus.sources
              .filter((source) => source.kind === kind.key)
              .map((source, index) => (
                <Text key={index} size="xs" pl={8}>
                  - {source.kind === "summon" ? `${translateSummonId(source.sourceId)} ` : ""}
                  {formatBonusAmount(source.value)}
                </Text>
              ))}
          </Box>
        )
      )}
    >
      <Text size="xs" fs="italic" fw={300} style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {bonus.name}
        <Text span size="xs" ml="auto">
          {formatBonusTotals(bonus.totals)}
        </Text>
      </Text>
    </Tooltip>
  );
};

/** Flips one key's membership in a set-as-state, returning a new set. */
const toggleKey = (previous: Set<string>, key: string): Set<string> => {
  const next = new Set(previous);
  if (!next.delete(key)) next.add(key);
  return next;
};

// A Computed group line: how many equipped sigils are of the given in-game
// types (a sigil's type is its FIRST trait's type), out of the 5 each check
// targets — e.g. the DMG Cap skillboard node counts 5 Basic Stats-type sigils.
const SigilCategoryRow = ({
  player,
  categories,
  label,
}: {
  player: PlayerData;
  categories: SigilCategory[];
  label: string;
}) => {
  const { t } = useTranslation();
  const matches = collectSigilsByCategory(player, categories);
  const { Icon, color } = CHECKLIST_DISPLAY[checklistStatus(matches.length, SIGIL_CATEGORY_TARGET)];

  return (
    <Tooltip
      disabled={matches.length === 0}
      color="dark"
      position="top-start"
      label={
        <Box>
          <Text size="xs" fw={600}>
            {t("ui.player-sigils")}
          </Text>
          {matches.map((sigil, index) => (
            <Text key={index} size="xs" pl={8}>
              - {translateSigilId(sigil.sigilId)} {t("ui.trait-level", { level: sigil.sigilLevel })}
            </Text>
          ))}
        </Box>
      }
    >
      <Text size="xs" fw={300} c={color} style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Icon size="0.9rem" weight="bold" /> {t(label)}
        <Text span size="xs" ml="auto">
          ({matches.length}/{SIGIL_CATEGORY_TARGET})
        </Text>
      </Text>
    </Tooltip>
  );
};

// A Sigil Traits line: name left, level/cap right (checklist-style layout).
// The status icon/color only appears past the trait's effect cap — levels
// beyond it are wasted; anything at or under the cap is unremarkable. Traits
// whose cap the game table doesn't know keep the plain "(Lvl. N)" form.
const SigilTraitRow = ({ trait }: { trait: CombinedTrait & { name: string } }) => {
  const max = traitMaxLevel(trait.id);
  const over = max !== null && trait.level > max;
  const { Icon, color } = CHECKLIST_DISPLAY.over;

  return (
    <Text
      size="xs"
      fs="italic"
      fw={300}
      c={over ? color : undefined}
      style={{ display: "flex", alignItems: "center", gap: 4 }}
    >
      {over && <Icon size="0.9rem" weight="bold" />}
      {trait.name}
      <Text span size="xs" ml="auto">
        {max === null ? `(Lvl. ${trait.level})` : `(${trait.level}/${max})`}
      </Text>
    </Text>
  );
};

/** The 4 equipped skills (v2.0.2 identity path), one column per player —
 * shared by the Equipment and Builds tabs. The hook drops empty slots, so the
 * array holds only real ability ids. */
const AbilitiesRow = ({ playerData }: { playerData: PlayerData[] }) => {
  const { t } = useTranslation();

  return (
    <Table.Tr>
      {playerData.map((player) => {
        const abilities = player.abilities || [];

        return (
          <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
            <Text size="xs" fw={700}>
              {t("ui.player-abilities")}
            </Text>
            {Array.from(Array(4).keys()).map((abilityIndex) => {
              const ability = abilities[abilityIndex];

              return (
                <Placeholder key={abilityIndex} empty={!ability}>
                  <Text size="xs" fs="italic" fw={300}>
                    {translateAbilityId(ability ?? null)}
                  </Text>
                </Placeholder>
              );
            })}
          </Table.Td>
        );
      })}
    </Table.Tr>
  );
};

/** The quest-detail tabs, and the subset selectable on a log that carries no
 * player data (older logs, and every log before its state has loaded). */
const VIEW_TABS = ["overview", "sba", "equipment", "builds"] as const;
const DATALESS_VIEW_TABS = ["overview", "sba"] as const;

/** No verdicts at all, for when the user has asked not to see them. One frozen
 * instance so substituting it never invalidates a memo. */
const NO_LEGALITY: LegalityFinding[][] = [];

export const ClassicView = () => {
  const { color_1, color_2, color_3, color_4, show_display_names, streamer_mode } = useMeterSettingsStore(
    useShallow((state) => ({
      color_1: state.color_1,
      color_2: state.color_2,
      color_3: state.color_3,
      color_4: state.color_4,
      show_display_names: state.show_display_names,
      streamer_mode: state.streamer_mode,
    }))
  );
  // Separate atomic selector rather than folding into the shallow group above:
  // this one drives the backend fetches below, so it wants the tightest possible
  // change signal — every change re-derives the whole log.
  const filters = useMeterFilters();
  const checklistGroups = useChecklistStore(useShallow((state) => state.groups));
  const { t, i18n } = useTranslation();
  const { id } = useParams();

  /**
   * Back to the quest list, unless the link that opened this log named
   * somewhere else. See `useBackTo` for why this is not a history walk.
   */
  const goBack = useBackTo();

  const {
    encounter,
    dpsChart,
    hpChart,
    sbaChart,
    sbaEvents,
    chartLen,
    sbaChartLen,
    targetEntries,
    selectedTargetSpans,
    questId,
    questTimer,
    questCompleted,
    roomIndex,
    imported,
    playerData,
    legality: storedLegality,
    setSelectedTargetSpans,
    loadFromResponse,
  } = useEncounterStore((state) => ({
    encounter: state.encounterState,
    dpsChart: state.dpsChart,
    hpChart: state.hpChart,
    sbaChart: state.sbaChart,
    sbaEvents: state.sbaEvents,
    chartLen: state.chartLen,
    sbaChartLen: state.sbaChartLen,
    targetEntries: state.targetEntries,
    selectedTargetSpans: state.selectedTargetSpans,
    playerData: state.players,
    legality: state.legality,
    questId: state.questId,
    questTimer: state.questTimer,
    questCompleted: state.questCompleted,
    roomIndex: state.roomIndex,
    imported: state.imported,
    setSelectedTargetSpans: state.setSelectedTargetSpans,
    loadFromResponse: state.loadFromResponse,
  }));
  // The app-wide switch is honoured once, here, rather than at each of the
  // dozen marks below: with no findings in hand every LegalityMark, FlaggedGear
  // and LegalityPlayerName renders its children untouched, which is already
  // what they do for a clean build. A frozen constant so the substitution does
  // not hand a fresh array to the memos downstream on every render.
  const show_flagged_builds = useMeterSettingsStore((state) => state.show_flagged_builds);
  const legality = show_flagged_builds ? storedLegality : NO_LEGALITY;
  // The open tab lives in the URL, so leaving this page and coming back through
  // the Logs tab returns to it. Equipment and Builds are disabled without
  // player data, so they only become selectable once it has loaded.
  const [tab, setTab] = useTabParam(playerData.length === 0 ? DATALESS_VIEW_TABS : VIEW_TABS, "overview");
  // Builds tab: the combined traits scan all of a player's equipment, and two
  // rows (checklist + sigil traits) need them — computed once per player here.
  const combinedTraitsByPlayer = useMemo(
    () => new Map(playerData.map((player) => [player.actorIndex, computeCombinedTraits(player)])),
    [playerData]
  );
  // The visible groups are the same for every player column — filter and order
  // them once instead of once per player. A group survives if it is switched on
  // and either derives its rows (computed) or has an enabled entry. Memoized on
  // the language too: the alphabetical order is by translated trait name, and
  // this page re-renders on every pointermove of an overview scrub.
  const visibleChecklistGroups = useMemo(
    () =>
      checklistGroups
        .filter((group) => group.enabled && (group.kind === "computed" || group.entries.some((entry) => entry.enabled)))
        .map((group) => ({
          ...group,
          entries: orderedChecklistEntries(
            group.entries.filter((entry) => entry.enabled),
            group.manualOrder
          ),
        })),
    [checklistGroups, i18n.language]
  );

  const [sortType, setSortType] = useState<SortType>(MeterColumns.TotalDamage);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  // Committed scrub window on the overview charts, as [start, end] second
  // indexes; null = the full fight. `pendingRange` tracks the handles DURING a
  // drag — only the cheap shade/label layers follow it live; the charts slice
  // and the meter reparses when the drag commits on release.
  const [range, setRange] = useState<[number, number] | null>(null);
  const [pendingRange, setPendingRange] = useState<[number, number] | null>(null);
  // Meter state reparsed over the committed window; null = show the full fight.
  const [scrubbedEncounter, setScrubbedEncounter] = useState<EncounterState | null>(null);
  // Shared so toggling a master-trait tier or branch expands/collapses it for
  // every player column at once. Both start collapsed — the section header's
  // per-branch activation pips are the at-a-glance summary, so the rows below
  // only need to open when someone wants the individual nodes.
  const [expandedMasterTraitTiers, setExpandedMasterTraitTiers] = useState<Set<string>>(new Set());
  const [expandedMasterTraitCategories, setExpandedMasterTraitCategories] = useState<Set<string>>(new Set());
  const toggleMasterTraitTier = useCallback((tierId: string) => {
    setExpandedMasterTraitTiers((previous) => toggleKey(previous, tierId));
  }, []);
  const toggleMasterTraitCategory = useCallback((categoryId: string) => {
    setExpandedMasterTraitCategories((previous) => toggleKey(previous, categoryId));
  }, []);
  const setAllMasterTraitTiers = useCallback((tierIds: string[], expand: boolean) => {
    setExpandedMasterTraitTiers(expand ? new Set(tierIds) : new Set());
  }, []);

  // The target filter's MultiSelect value, derived from the store's
  // selectedTargetSpans (the single source of truth) — the dropdown encodes a
  // span as "id:start:end".
  const selectedTargets = useMemo(
    () => selectedTargetSpans.map((span) => `${span.id}:${span.startMs}:${span.endMs}`),
    [selectedTargetSpans]
  );

  // Navigating to a different log clears every quest-detail filter — enemy
  // selection and time window — so the new log never renders through the
  // previous one's filters. The spans clear re-runs this effect, which then
  // fetches unfiltered (the sentinel start value makes a fresh mount with
  // stale store spans take the clear path too).
  const lastLoadedId = useRef<string | undefined>(undefined);
  // `fetch_encounter_state` is a `#[tauri::command(async)]`, so responses are NOT ordered
  // with respect to the requests that issued them: a slow reparse can land after a newer
  // one. Each response checks its generation and drops itself once superseded. The two
  // kinds are counted separately — a full load and a window reparse write different state,
  // and clearing the window must not also cancel an in-flight load.
  const loadGeneration = useRef(0);
  const windowGeneration = useRef(0);
  useEffect(() => {
    const idChanged = lastLoadedId.current !== id;
    lastLoadedId.current = id;
    if (idChanged && selectedTargetSpans.length > 0) {
      setSelectedTargetSpans([]);
      return;
    }

    const generation = ++loadGeneration.current;
    // A load resets the window, so any window fetch still in flight is stale too.
    windowGeneration.current += 1;
    invoke("fetch_encounter_state", {
      id: Number(id),
      options: { targetSpans: selectedTargetSpans, filters },
    })
      .then((result) => {
        if (generation !== loadGeneration.current) return;
        loadFromResponse(result as EncounterStateResponse);
        setRange(null);
        setPendingRange(null);
        setScrubbedEncounter(null);
      })
      .catch((e) => {
        if (generation !== loadGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
    // Keyed on the filter too: toggling it must re-derive the open log, charts
    // included, not just the next one the user opens.
  }, [id, selectedTargetSpans, filters]);

  // Brush release: commit the window and reparse the meter over exactly that
  // span. A window covering the whole track clears back to the (already
  // loaded) full-fight state without a refetch.
  const handleRangeCommit = useCallback(
    (value: [number, number]) => {
      setPendingRange(null);
      if (value[0] <= 0 && value[1] >= chartLen) {
        setRange(null);
        setScrubbedEncounter(null);
        return;
      }
      setRange(value);
      const generation = ++windowGeneration.current;
      invoke("fetch_encounter_state", {
        id: Number(id),
        options: {
          targetSpans: selectedTargetSpans,
          filters,
          fromMs: value[0] * DPS_BUCKET_MS,
          // Buckets are inclusive at BOTH ends in the charts, so the window the user sees
          // is [start, end] whole seconds. `fromMs` admits all of the first bucket, so the
          // cutoff has to admit all of the last one too — sending `end * 1000` reparsed a
          // window one bucket shorter than the highlighted region.
          upToMs: (value[1] + 1) * DPS_BUCKET_MS - 1,
          // Only the derived state is consumed here — the charts stay from the
          // full fetch — so skip chart building backend-side.
          stateOnly: true,
        },
      })
        .then((result) => {
          if (generation !== windowGeneration.current) return;
          setScrubbedEncounter((result as EncounterStateResponse).encounterState);
        })
        .catch((e) => {
          if (generation !== windowGeneration.current) return;
          // The window is already committed, so the charts are zoomed and the badge
          // advertises it — clear back to the full fight rather than leave the meter
          // showing full-fight totals under a window label.
          setRange(null);
          toast.error(`Failed to fetch encounter state: ${e}`);
        });
    },
    [id, selectedTargetSpans, chartLen, filters]
  );

  const resetWindow = useCallback(() => {
    // Supersede any in-flight window fetch so it can't re-apply after the reset.
    windowGeneration.current += 1;
    setPendingRange(null);
    setRange(null);
    setScrubbedEncounter(null);
  }, []);

  const handleCharacterDataCopy = useCallback((player: PlayerData) => {
    if (player) exportCharacterDataToClipboard(player);
  }, []);

  const handleOpenDamageCalculator = useCallback((player: PlayerData) => {
    if (player) openDamageCalculator(player);
  }, []);

  const handleSimpleEncounterCopy = useCallback(() => {
    if (encounter) exportSimpleEncounterToClipboard(sortType, sortDirection, encounter, playerData);
  }, [sortType, sortDirection, encounter]);

  const handleFullEncounterCopy = useCallback(() => {
    if (encounter) exportFullEncounterToClipboard(sortType, sortDirection, encounter, playerData);
  }, [sortType, sortDirection, encounter]);

  const handleScreenshotCopy = useCallback(() => {
    exportScreenshotToClipboard("#log-view-page");
  }, []);

  // Exports what the view shows: the target filter AND the committed scrub window, so a
  // CSV taken from a windowed view doesn't silently contain the whole fight.
  const exportDamageLogToFile = useCallback(() => {
    if (!id) return;
    invoke("export_damage_log_to_file", {
      id: Number(id),
      options: {
        targetSpans: selectedTargetSpans,
        filters,
        ...(range ? { fromMs: range[0] * DPS_BUCKET_MS, upToMs: (range[1] + 1) * DPS_BUCKET_MS - 1 } : {}),
      },
    });
  }, [id, selectedTargetSpans, range, filters]);

  // Display labels for every target spawn segment, keyed by
  // `targetLabelKey` — shared by the HP-chart legend, the target-filter dropdown
  // and the analysis view's target pin, so no two of them can disagree on a
  // label. Computed ONCE from targetEntries (the dropdown's superset
  // population) and looked up by the chart. The rule lives in targetLabels.ts.
  const targetLabels = useMemo(
    () => buildTargetLabels(targetEntries, translateEnemyType),
    // `i18n.language` re-derives the labels on language change — the translate
    // helper reads the module-level i18n instance.
    [targetEntries, i18n.language]
  );

  const players = useMemo(() => (encounter ? formatInPartyOrder(encounter.party) : []), [encounter]);

  // Chart series names for a per-player chart keyed by actor index — shared by
  // the DPS and SBA charts so the display-name rules (streamer mode, display
  // names toggle) live in one place.
  const buildPlayerSeriesNames = useCallback(
    (chart: Record<number, unknown>) => {
      const seriesNames = new Map<string, string>();
      for (const playerIndex in chart) {
        const player = players.find((p) => p.index === Number(playerIndex));
        const partySlotIndex = playerData.findIndex((partyMember) => partyMember?.actorIndex === player?.index);
        seriesNames.set(
          playerIndex,
          translatedPlayerName(
            partySlotIndex,
            playerData[partySlotIndex],
            player as ComputedPlayerState,
            show_display_names && !streamer_mode
          )
        );
      }
      return seriesNames;
    },
    [players, playerData, show_display_names, streamer_mode]
  );

  // Per-player smoothed DPS series, one point per second. Everything below is
  // memoized on the underlying log — a brush drag re-renders the page on every
  // pointer move and must not rebuild any of it.
  const data = useMemo(() => {
    const seriesNames = buildPlayerSeriesNames(dpsChart);

    const rows: ChartDatapoint[] = [];
    for (let i = 0; i < chartLen + 1; i++) {
      const datapoint: ChartDatapoint = {};
      datapoint["timestamp"] = millisecondsToElapsedFormat(i * DPS_BUCKET_MS);
      datapoint["party"] = 0;
      rows.push(datapoint);
    }

    // One pass per player carrying a running sum, rather than re-slicing and re-reducing
    // the trailing window at every bucket: buckets are now per-SECOND and the window is
    // 10 wide, so the naive form allocated one array and did ~10 adds per bucket per
    // player — thousands of throwaway arrays before the chart's first paint.
    for (const playerIndex in dpsChart) {
      const values = dpsChart[playerIndex];
      const name = seriesNames.get(playerIndex) as string;
      let sum = 0;
      for (let i = 0; i < rows.length; i++) {
        if (i < values.length) sum += values[i];
        const dropped = i - DPS_SMOOTHING_WINDOW;
        if (dropped >= 0 && dropped < values.length) sum -= values[dropped];

        // `rows` runs one past `values` (the chart gets a trailing bucket), so the
        // divisor is the count of REAL samples in the window, matching what slicing
        // the array used to yield.
        const start = Math.max(i - (DPS_SMOOTHING_WINDOW - 1), 0);
        const end = Math.min(i, values.length - 1);
        const width = end - start + 1;
        const value = width > 0 ? Math.round(sum / width) : 0;

        rows[i][name] = value;
        rows[i]["party"] = (rows[i]["party"] as number) + value;
      }
    }

    return rows;
  }, [chartLen, dpsChart, buildPlayerSeriesNames]);

  // Enemy HP% series, one line per charted pool, kept separate from DPS
  // (different scale — never a dual axis) but with a synced hover crosshair.
  // Same bucket count as `data`, so recharts' index-based sync lines the
  // charts up exactly. HP only changes when hit, so each line forward-fills
  // its last known value across unhit buckets — otherwise the line cuts off
  // wherever the pool takes no damage (e.g. the boss flying away), which is
  // especially visible inside a scrub window.
  // Kept OUT of the hpData memo below: hpSeries depends only on the HP pools and their
  // labels, but hpData needs `data` for its timestamp column. Deriving both together gave
  // hpSeries `data`'s dependency chain (which reaches show_display_names / streamer_mode),
  // so flipping an unrelated display setting minted a new hpSeries identity and the
  // defaultHidden effect below wiped whichever HP lines the user had just un-hidden.
  const hpSeries = useMemo(() => {
    // "Boss" = a pool at least a quarter the size of the fight's largest pool
    // (the only boss signal in the data — bosses dwarf summons and adds, while
    // co-bosses are comparable). Non-boss lines start toggled off.
    const largestMax = hpChart.reduce((acc, series) => Math.max(acc, series.maxHp), 0);
    return hpChart.map((series, index) => ({
      name: targetLabels.get(targetLabelKey(series.enemyType, series.instance)) ?? translateEnemyType(series.enemyType),
      color: HP_SERIES_COLORS[index % HP_SERIES_COLORS.length],
      defaultHidden: series.maxHp < largestMax / 4,
    }));
  }, [hpChart, targetLabels]);

  const hpData = useMemo(() => {
    // Forward-fill only INSIDE a pool's lifetime (first to last real report):
    // HP holds its last known value across unhit stretches, but a dead or
    // despawned pool must end, not drag a flat line to the end of the fight.
    const filled = hpChart.map((series) => {
      const lastReport = series.values.reduce((acc: number, value, i) => (value != null ? i : acc), -1);
      let last: number | null = null;
      return series.values.map((value, i) => {
        if (i > lastReport) return null;
        return value != null ? (last = value) : last;
      });
    });

    return data.map((row, bucket) => {
      const point: HpDatapoint = { timestamp: row.timestamp };
      hpSeries.forEach((series, seriesIndex) => {
        point[series.name] = filled[seriesIndex][bucket] ?? null;
      });
      return point;
    });
  }, [data, hpChart, hpSeries]);

  // Legend chips toggle HP lines; non-boss pools (summons, adds) start hidden.
  // Reapplied whenever the series set changes (new log, target filter, language).
  const [hiddenHpSeries, setHiddenHpSeries] = useState<Set<string>>(new Set());
  useEffect(() => {
    setHiddenHpSeries(new Set(hpSeries.filter((series) => series.defaultHidden).map((series) => series.name)));
  }, [hpSeries]);
  const toggleHpSeries = useCallback((name: string) => {
    setHiddenHpSeries((previous) => {
      const next = new Set(previous);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const { labels, sbaLabels } = useMemo(() => {
    const playerColors = [color_1, color_2, color_3, color_4, ...PLAYER_COLORS.slice(4)];
    const base: Label = players.map((player) => {
      const partySlotIndex = playerData.findIndex((partyMember) => partyMember?.actorIndex === player.index);
      const color = resolvePlayerColor(playerColors, playerData, partySlotIndex, player.partyIndex);

      return {
        name: translatedPlayerName(
          partySlotIndex,
          playerData[partySlotIndex],
          player,
          show_display_names && !streamer_mode
        ),
        damage: player.totalDamage,
        partySlotIndex,
        color,
      };
    });

    // Chart every actor that actually has SBA gauge data (AI companions have no
    // playerData slot match, but their OnUpdateSBA events are recorded all the same).
    const sbaLabels = base.filter((_, index) => {
      const player = players[index];
      return player !== undefined && sbaChart[player.index] !== undefined;
    });

    const labels: Label = [
      ...base,
      {
        name: "party",
        partySlotIndex: -1,
        label: t("ui.logs.damage-per-second"),
        color: "grey",
        strokeDasharray: "2 2",
      },
    ];

    return { labels, sbaLabels };
  }, [players, playerData, color_1, color_2, color_3, color_4, show_display_names, streamer_mode, sbaChart, t]);

  const sbaData = useMemo(() => {
    const seriesNames = buildPlayerSeriesNames(sbaChart);

    const rows: ({ timestamp?: string } & { [key: string]: number })[] = [];
    for (let i = 0; i < sbaChartLen; i++) {
      const sbaDatapoint: { timestamp?: string } & { [key: string]: number } = {};
      sbaDatapoint["timestamp"] = millisecondsToElapsedFormat(i * DPS_BUCKET_MS);

      for (const playerIndex in sbaChart) {
        sbaDatapoint[seriesNames.get(playerIndex) as string] = sbaChart[playerIndex][i] / 10.0;
      }

      rows.push(sbaDatapoint);
    }
    return rows;
  }, [sbaChart, sbaChartLen, buildPlayerSeriesNames]);

  // Target-filter dropdown: one entry per SPAWN SEGMENT — exactly the units
  // the HP chart draws, same #n numbers — grouped under the enemy's name.
  // Values encode the segment's span, because a spawn id alone is not unique
  // across a fight (waves reuse freed instance ids). The pool size is added
  // when one name spans different sizes.
  const targetOptions = useMemo(() => {
    const groups = new Map<string, { value: string; label: string; maxHp: number; instance: number }[]>();
    for (const entry of targetEntries) {
      const name = translateEnemyType(entry.enemyType);
      const label = targetLabels.get(targetLabelKey(entry.enemyType, entry.instance)) ?? name;

      let group = groups.get(name);
      if (!group) groups.set(name, (group = []));
      group.push({
        value: `${entry.id}:${entry.startMs}:${entry.endMs}`,
        label,
        maxHp: entry.maxHp ?? 0,
        instance: entry.instance,
      });
    }

    // Biggest pools first — the boss group on top, then within a group the
    // larger variants first (spawn order breaks ties; unknown HP sinks last).
    return [...groups.entries()]
      .sort(([, a], [, b]) => Math.max(...b.map((item) => item.maxHp)) - Math.max(...a.map((item) => item.maxHp)))
      .map(([group, items]) => ({
        group,
        items: items
          .sort((a, b) => b.maxHp - a.maxHp || a.instance - b.instance)
          .map(({ value, label }) => ({ value, label })),
      }));
  }, [targetEntries, targetLabels]);

  // The scrub window, clamped (log switches change the bucket count). The
  // detail charts and the meter follow the COMMITTED window; the shades and
  // labels follow the handles live via `shownRange`.
  const maxIndex = Math.max(data.length - 1, 0);
  const clampIndex = (value: number) => Math.max(0, Math.min(value, maxIndex));
  const committedStart = range ? clampIndex(range[0]) : 0;
  const committedEnd = range ? clampIndex(range[1]) : maxIndex;
  const isWindowed = committedStart > 0 || committedEnd < maxIndex;
  const shownRange: [number, number] = pendingRange ?? [committedStart, committedEnd];

  const detailData = useMemo(
    () => (isWindowed ? data.slice(committedStart, committedEnd + 1) : data),
    [data, isWindowed, committedStart, committedEnd]
  );
  const detailHpData = useMemo(
    () => (isWindowed ? hpData.slice(committedStart, committedEnd + 1) : hpData),
    [hpData, isWindowed, committedStart, committedEnd]
  );
  const overviewData = useMemo(() => data.map((row) => ({ timestamp: row.timestamp, party: row.party })), [data]);

  if (!encounter) {
    return (
      <Box>
        <Text>
          <Anchor component="button" type="button" onClick={goBack}>
            {t("ui.back-btn")}
          </Anchor>
        </Text>
        <Divider my="sm" />
        <Text>{t("ui.loading")}</Text>
      </Box>
    );
  }

  const windowActive = isWindowed || pendingRange !== null;
  const windowStart = millisecondsToElapsedFormat(shownRange[0] * DPS_BUCKET_MS);
  const windowEnd = millisecondsToElapsedFormat(shownRange[1] * DPS_BUCKET_MS);
  const windowDuration = millisecondsToElapsedFormat((shownRange[1] - shownRange[0]) * DPS_BUCKET_MS);
  const fullDuration = millisecondsToElapsedFormat(maxIndex * DPS_BUCKET_MS);

  return (
    <Box>
      <Text>
        <Box display="flex">
          <Box display="flex" flex={1}>
            <Button size="xs" variant="default" onClick={goBack}>
              {t("ui.back-btn")}
            </Button>
          </Box>
          <Flex display="flex" flex={1} justify={"flex-end"}>
            <Menu shadow="md" trigger="hover" openDelay={100} closeDelay={400}>
              <Menu.Target>
                <ActionIcon aria-label="Clipboard" variant="filled" color="light">
                  <ClipboardText size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={handleSimpleEncounterCopy}>{t("ui.copy-to-clipboard-simple")}</Menu.Item>
                <Menu.Item onClick={handleFullEncounterCopy}>{t("ui.copy-to-clipboard-full")}</Menu.Item>
                <Menu.Item onClick={handleScreenshotCopy}>{t("ui.copy-screenshot-to-clipboard")}</Menu.Item>
                <Menu.Item onClick={exportDamageLogToFile}>{t("ui.export-damage-log")}</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Flex>
        </Box>
      </Text>

      <Divider my="sm" />

      <Box id="log-view-page">
        <QuestHeader
          encounter={encounter}
          questId={questId}
          roomIndex={roomIndex}
          questCompleted={questCompleted}
          questTimer={questTimer}
          imported={imported}
        />

        <Divider my="sm" />

        <Tabs value={tab} onChange={setTab} variant="outline" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="overview">{t("ui.logs.overview")}</Tabs.Tab>
            <Tabs.Tab value="sba">{t("ui.logs.sba-chart")}</Tabs.Tab>
            <Tabs.Tab value="equipment" disabled={playerData.length === 0}>
              {t("ui.logs.equipment")}
            </Tabs.Tab>
            <Tabs.Tab value="builds" disabled={playerData.length === 0}>
              {t("ui.logs.builds")}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview">
            <Box mt="md">
              <Stack>
                <MultiSelect
                  data={targetOptions}
                  placeholder={t("ui.logs.filter-all")}
                  clearable
                  value={selectedTargets}
                  onChange={(value) => {
                    setSelectedTargetSpans(
                      value.map((encoded) => {
                        const [id, startMs, endMs] = encoded.split(":").map(Number);
                        return { id, startMs, endMs };
                      })
                    );
                  }}
                />
                {/* The meter shows whatever window the brush selects — this row,
                    fixed-height so it never shifts the table, states that window.
                    It follows the handles live during a drag. */}
                <Group gap="xs" align="center" wrap="nowrap" h={22}>
                  {windowActive ? (
                    <>
                      <Badge
                        size="sm"
                        radius="sm"
                        variant="light"
                        color="yellow"
                        style={{ textTransform: "none", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
                      >
                        {windowStart} – {windowEnd}
                      </Badge>
                      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {t("ui.logs.window-of", { selected: windowDuration, total: fullDuration })}
                      </Text>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        leftSection={<X size={12} weight="bold" />}
                        onClick={resetWindow}
                      >
                        {t("ui.logs.window-reset")}
                      </Button>
                    </>
                  ) : (
                    <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {t("ui.logs.window-full")} · {fullDuration}
                    </Text>
                  )}
                  <Box ml="auto">
                    <ColumnsPopover />
                  </Box>
                </Group>
                <MemoMeterTable
                  encounterState={scrubbedEncounter ?? encounter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  setSortType={setSortType}
                  setSortDirection={setSortDirection}
                  partyData={playerData}
                  legality={legality}
                />
                <DetailCharts
                  data={detailData}
                  hpData={detailHpData}
                  hpSeries={hpSeries}
                  hiddenHpSeries={hiddenHpSeries}
                  onToggleHpSeries={toggleHpSeries}
                  labels={labels}
                />
                {/* Full-fight context strip + two-ended brush: drag the handles
                    to zoom the charts and scope the meter to that window. */}
                {maxIndex > 0 && (
                  <Box>
                    <Box
                      pos="relative"
                      style={{ marginLeft: CHART_MARGIN + CHART_Y_AXIS_WIDTH, marginRight: CHART_MARGIN }}
                    >
                      <OverviewChart data={overviewData} />
                      <Box style={brushShade("left", (shownRange[0] / maxIndex) * 100)} />
                      <Box style={brushShade("right", 100 - (shownRange[1] / maxIndex) * 100)} />
                    </Box>
                    <RangeSlider
                      mt={4}
                      size="sm"
                      color="yellow"
                      min={0}
                      max={maxIndex}
                      step={1}
                      minRange={Math.min(5, maxIndex)}
                      value={shownRange}
                      onChange={setPendingRange}
                      onChangeEnd={handleRangeCommit}
                      label={(value) => millisecondsToElapsedFormat(value * DPS_BUCKET_MS)}
                      style={{ marginLeft: CHART_MARGIN + CHART_Y_AXIS_WIDTH, marginRight: CHART_MARGIN }}
                    />
                  </Box>
                )}
              </Stack>
            </Box>
          </Tabs.Panel>
          <Tabs.Panel value="sba">
            <Group mt="20" gap="xs">
              <Text size="sm">{t("ui.logs.sba-chart")}</Text>
              <LineChart
                h={400}
                data={sbaData}
                dataKey="timestamp"
                withDots={false}
                withLegend
                series={sbaLabels}
                valueFormatter={(value) => {
                  return `${value}%`;
                }}
                tooltipProps={{
                  content: ({ label, payload }) => <ChartTooltip label={label} payload={payload} />,
                }}
              />
              <Table striped layout="fixed">
                <Table.Tbody>
                  {sbaEvents.map((payload, index) => {
                    const [timestamp, event] = payload;
                    const eventType = Object.keys(event)[0];

                    // @ts-expect-error: eventType is dynamic here.
                    const player = players.find((p) => p.index === event[eventType].actor_index);

                    const partySlotIndex = playerData.findIndex(
                      // @ts-expect-error: eventType is dynamic here.
                      (partyMember) => partyMember?.actorIndex === event[eventType].actor_index
                    );

                    const playerName = translatedPlayerName(
                      partySlotIndex,
                      playerData[partySlotIndex],
                      player as ComputedPlayerState,
                      show_display_names && !streamer_mode
                    );

                    return (
                      <Table.Tr key={index}>
                        <Table.Td>
                          <Text size="xs">{millisecondsToElapsedFormat(timestamp)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {playerName} - {t(`ui.sba.${eventType}`)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Group>
          </Tabs.Panel>
          <Tabs.Panel value="equipment">
            <Group mt="20" gap="xs">
              <Table striped layout="fixed">
                <Table.Tbody>
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      return (
                        <Table.Td key={player.actorIndex} flex={1}>
                          <Flex direction="row" wrap="nowrap" align="center">
                            <Text fw={700} size="xl" mr="5">
                              <LegalityPlayerName findings={legality[playerIndex] ?? []}>
                                {formatPlayerDisplayName(player, show_display_names && !streamer_mode, false)}
                              </LegalityPlayerName>
                            </Text>
                            <Tooltip label={t("ui.copy-character-data-to-clipboard")} color="dark">
                              <ActionIcon
                                aria-label="Clipboard"
                                variant="filled"
                                color="light"
                                onClick={() => handleCharacterDataCopy(player)}
                              >
                                <ClipboardText size={16} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label={t("ui.open-damage-calculator")} color="dark">
                              <ActionIcon
                                aria-label="Open build"
                                variant="filled"
                                color="light"
                                disabled
                                onClick={() => handleOpenDamageCalculator(player)}
                              >
                                <Calculator size={16} />
                              </ActionIcon>
                            </Tooltip>
                          </Flex>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player) => {
                      return (
                        <Table.Td key={player.actorIndex}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-stats")}
                          </Text>
                          <Text size="xs" fs="italic" fw={300}>
                            {t("ui.stats.level")}: {getPlayerLevel(player)}
                          </Text>
                          {(player.masterLevel || 0) > 0 && (
                            <Text size="xs" fs="italic" fw={300}>
                              {/* The game stores level+stars combined (cap 50, then stars). */}
                              {t("ui.stats.master-level")}:{" "}
                              {player.masterLevel > 50 ? `50 (+${player.masterLevel - 50}★)` : player.masterLevel}
                            </Text>
                          )}
                          {/* v2.0.2 record-inline stat block (identity-path recovery). Each row
                              gates on its own value so a partially-populated record (the
                              in-quest fill skips two slots) shows what it has. */}
                          {player.stats && (
                            <>
                              {player.stats.hp > 0 && (
                                <Text size="xs" fs="italic" fw={300}>
                                  {t("ui.stats.total-hp")}: {player.stats.hp.toLocaleString()}
                                </Text>
                              )}
                              {player.stats.attack > 0 && (
                                <Text size="xs" fs="italic" fw={300}>
                                  {t("ui.stats.total-attack")}: {player.stats.attack.toLocaleString()}
                                </Text>
                              )}
                              {player.stats.criticalRate > 0 && (
                                <Text size="xs" fs="italic" fw={300}>
                                  {t("ui.stats.critical-rate")}: {player.stats.criticalRate.toFixed(0)}%
                                </Text>
                              )}
                              {/* No `* 10` here: that scaling compensates for the pre-2.0
                                  PlayerLoadEvent source below and must not be applied to the
                                  record block's own stun power. */}
                              {player.stats.stunPower > 0 && (
                                <Text size="xs" fs="italic" fw={300}>
                                  {t("ui.stats.stun-power")}: {player.stats.stunPower.toFixed(0)}
                                </Text>
                              )}
                              {player.stats.power > 0 && (
                                <Text size="xs" fs="italic" fw={300}>
                                  {t("ui.stats.total-power")}: {player.stats.power.toLocaleString()}
                                </Text>
                              )}
                            </>
                          )}
                          {/* HP/ATK/crit/stun/power from the legacy (pre-2.0) PlayerLoadEvent;
                              `totalPower` is set only by that event, so it gates the whole
                              block. Kept for logs recorded before the record-stat recovery. */}
                          {!player.stats && (player.playerStats?.totalPower || 0) > 0 && (
                            <>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.stats.total-hp")}: {player.playerStats?.totalHp || 1}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.stats.total-attack")}: {player.playerStats?.totalAttack || 1}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.stats.critical-rate")}: {(player.playerStats?.criticalRate || 0).toFixed(0)}%
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.stats.stun-power")}: {((player.playerStats?.stunPower || 0) * 10).toFixed(0)}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.stats.total-power")}: {player.playerStats?.totalPower || 1}
                              </Text>
                            </>
                          )}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      const overmasteries = player.overmasteryInfo?.overmasteries || [];
                      const findings = legality[playerIndex] ?? [];

                      return (
                        <Table.Td key={player.actorIndex}>
                          <Text size="xs" fw={700}>
                            <LegalityMark findings={findingsForSubject(findings, "overmasteries")}>
                              {t("ui.player-overmasteries")}
                            </LegalityMark>
                          </Text>
                          {Array.from(Array(4).keys()).map((overmasteryIndex) => {
                            const overmastery = overmasteries[overmasteryIndex];

                            return (
                              <Placeholder
                                key={overmasteryIndex}
                                empty={!overmastery || (overmastery.value === 0 && overmastery.flags === 0)}
                              >
                                <Text size="xs" fs="italic" fw={300}>
                                  <LegalityMark
                                    findings={findingsForSubject(findings, "overmastery", overmasteryIndex)}
                                  >
                                    {formatOvermastery(overmastery)}
                                  </LegalityMark>
                                </Text>
                              </Placeholder>
                            );
                          })}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <AbilitiesRow playerData={playerData} />
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      return (
                        <Table.Td key={player.actorIndex}>
                          <Text size="xs" fw={700}>
                            {t("ui.weapon")}
                          </Text>
                          {/* The full stat block comes only from the legacy PlayerLoadEvent; on
                              v2.0.2 the identity path recovers the weapon IDENTITY (key name) via
                              the save-side charid map, so show at least the weapon name when the
                              full info is absent. */}
                          {player.weaponState ? (
                            /* v2.0.2 identity-path recovery: the equipped weapon's save
                               state — id (hash keys the weapons bundle directly), uncap
                               stars, plus marks, awakening, the ACTIVE innate skills
                               (levels shown once located in the save data) and the
                               wrightstone with its trait levels. */
                            <>
                              <Text size="xs" fs="italic" fw={300}>
                                {createWeaponStars(player.weaponState.starLevel)}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {translateWeaponId(player.weaponState.weaponId)} +{player.weaponState.plusMarks}
                              </Text>
                              {(() => {
                                /* Derived from the innate skill levels vs the per-stage
                                   curves — needs a log recorded with level data. A derived
                                   stage implies a fully awakened weapon (transcending
                                   requires it), and remote players' awakening often fails
                                   to sync (reads 0) — so the stage overrides the display. */
                                const stage = deriveTranscendence(
                                  player.weaponState.weaponId,
                                  player.weaponState.innateTraits
                                );
                                return (
                                  <>
                                    <Text size="xs" fs="italic" fw={300}>
                                      {t("ui.awakening-level", {
                                        level: stage ? 10 : player.weaponState.awakeningLevel,
                                      })}
                                    </Text>
                                    {stage !== null && (
                                      <Text size="xs" fs="italic" fw={300}>
                                        {t("ui.transcendence-level", { stage })}
                                      </Text>
                                    )}
                                  </>
                                );
                              })()}
                              {player.weaponState.innateTraits.map((trait) => (
                                <Text size="xs" fs="italic" fw={300} key={trait.id}>
                                  {/* Through `traitLine` like the wrightstone lines below: this
                                      used to bake in an English "(Lvl. N)", so every non-English
                                      user read two spellings of the level in one column. */}
                                  - {traitLine(t, trait.id, trait.level).text}
                                </Text>
                              ))}
                              {/* Remote players sync the wrightstone's trait pairs but never its
                                  item id — id 0 with traits still means a stone is equipped, so
                                  show the traits under the generic label. */}
                              {(player.weaponState.wrightstoneId > 0 ||
                                player.weaponState.wrightstoneTraits.length > 0) && (
                                <FlaggedGear
                                  name={translateWrightstoneId(player.weaponState.wrightstoneId)}
                                  findings={findingsForSubject(legality[playerIndex] ?? [], "wrightstone")}
                                  explain="tooltip"
                                  lines={player.weaponState.wrightstoneTraits.map((trait) =>
                                    traitLine(t, trait.id, trait.level)
                                  )}
                                />
                              )}
                            </>
                          ) : !player.weaponInfo ? (
                            player.weaponKey ? (
                              /* Identity-only fallback: the equipped-state map's ASCII key.
                                 NOTE: live-disproven as the equipped weapon (it lags/points
                                 at another loadout's weapon) — kept only as a last resort
                                 when the save rows are unreadable. Static innate skills
                                 shown without levels (they can also lag behind awakening
                                 upgrades). */
                              <>
                                <Text size="xs" fs="italic" fw={300}>
                                  {translateWeaponKey(player.weaponKey)}
                                </Text>
                                {dedupeWeaponTraits(weaponInnateTraits(player.weaponKey)).map((trait) => (
                                  <Text size="xs" fs="italic" fw={300} key={trait.id}>
                                    - {translateTraitId(parseInt(trait.id, 16))}
                                    {trait.isAwakening ? ` (${t("ui.weapon-awakening")})` : ""}
                                  </Text>
                                ))}
                              </>
                            ) : (
                              <Placeholder empty />
                            )
                          ) : (
                            <>
                              <Text size="xs" fs="italic" fw={300}>
                                {createWeaponStars(player.weaponInfo?.starLevel || 0)}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {translateWeaponId(player.weaponInfo?.weaponId ?? null)} +{player.weaponInfo?.plusMarks}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.awakening-level", { level: player.weaponInfo?.awakeningLevel || 0 })}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                {t("ui.weapon-stats", {
                                  level: player.weaponInfo?.weaponLevel || 0,
                                  attack: player.weaponInfo?.weaponAttack || 0,
                                  hp: player.weaponInfo?.weaponHp || 0,
                                })}
                              </Text>
                              <Text size="xs" fw={700}>
                                {translateItemId(player.weaponInfo?.wrightstoneId || EMPTY_ID)}
                              </Text>
                              <Placeholder empty={!player.weaponInfo?.trait1Id || player.weaponInfo?.trait1Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait1Id || EMPTY_ID)}{" "}
                                  {t("ui.trait-level", { level: player.weaponInfo?.trait1Level })}
                                </Text>
                              </Placeholder>
                              <Placeholder empty={!player.weaponInfo?.trait2Id || player.weaponInfo?.trait2Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait2Id || EMPTY_ID)}{" "}
                                  {t("ui.trait-level", { level: player.weaponInfo?.trait2Level })}
                                </Text>
                              </Placeholder>
                              <Placeholder empty={!player.weaponInfo?.trait3Id || player.weaponInfo?.trait3Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait3Id || EMPTY_ID)}{" "}
                                  {t("ui.trait-level", { level: player.weaponInfo?.trait3Level })}
                                </Text>
                              </Placeholder>
                            </>
                          )}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      const summons = player.summons ?? [];
                      const findings = legality[playerIndex] ?? [];

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            <LegalityMark findings={findingsForSubject(findings, "summons")}>
                              {t("ui.player-summons")}
                            </LegalityMark>
                          </Text>
                          <Placeholder empty={summons.length === 0}>
                            {summons.map((summon, summonIndex) => (
                              <Box key={summonIndex} mt={summonIndex > 0 ? 4 : 0}>
                                <FlaggedGear
                                  name={translateSummonId(summon.summonId)}
                                  nameWeight={600}
                                  findings={findingsForSubject(findings, "summon", summonIndex)}
                                  explain="tooltip"
                                  lines={[
                                    traitLine(t, summon.mainTraitId, summon.mainTraitLevel),
                                    {
                                      id: summon.bonusId,
                                      level: summon.bonusLevel,
                                      text: `${translateSummonBonusId(summon.bonusId)} ${
                                        formatSummonBonusValue(summon.bonusId, summon.bonusLevel) ??
                                        t("ui.trait-level", { level: summon.bonusLevel + 1 })
                                      }`,
                                    },
                                  ]}
                                />
                              </Box>
                            ))}
                          </Placeholder>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <MasterTraitsRows
                    playerData={playerData}
                    legality={legality}
                    expandedTiers={expandedMasterTraitTiers}
                    expandedCategories={expandedMasterTraitCategories}
                    onToggleTier={toggleMasterTraitTier}
                    onToggleCategory={toggleMasterTraitCategory}
                    onToggleAll={setAllMasterTraitTiers}
                  />
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      // A finding indexes into the player's UNFILTERED sigil
                      // list, so the empty slots are dropped with their original
                      // positions in hand — otherwise a finding lands on
                      // whichever sigil happened to shift into that place.
                      const sigils = (player.sigils ?? [])
                        .map((sigil, slot) => ({ sigil, slot }))
                        .filter(({ sigil }) => sigil.sigilId !== EMPTY_ID);
                      const findings = legality[playerIndex] ?? [];

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-sigils")}
                            {sigils.length > 0 && ` (${sigils.length})`}
                          </Text>
                          <Placeholder empty={sigils.length === 0}>
                            {sigils.map(({ sigil, slot }, sigilIndex) => {
                              // The empty second slot is dropped, matching the
                              // snapshot the rules mark against — a rendered
                              // empty line would shift every index past it.
                              return (
                                <Box key={sigilIndex} mt={sigilIndex > 0 ? 4 : 0}>
                                  <FlaggedGear
                                    name={`${translateSigilId(sigil.sigilId)} ${t("ui.trait-level", {
                                      level: sigil.sigilLevel,
                                    })}`}
                                    nameWeight={600}
                                    findings={findingsForSubject(findings, "sigil", slot)}
                                    explain="tooltip"
                                    lines={[
                                      traitLine(t, sigil.firstTraitId, sigil.firstTraitLevel),
                                      ...(sigil.secondTraitId !== EMPTY_ID
                                        ? [traitLine(t, sigil.secondTraitId, sigil.secondTraitLevel)]
                                        : []),
                                    ]}
                                  />
                                </Box>
                              );
                            })}
                          </Placeholder>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Group>
          </Tabs.Panel>
          <Tabs.Panel value="builds">
            <Group mt="20" gap="xs">
              <Table striped layout="fixed">
                <Table.Tbody>
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => (
                      <Table.Td key={player.actorIndex} flex={1}>
                        <Text fw={700} size="xl">
                          <LegalityPlayerName findings={legality[playerIndex] ?? []}>
                            {formatPlayerDisplayName(player, show_display_names && !streamer_mode, false)}
                          </LegalityPlayerName>
                        </Text>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                  <AbilitiesRow playerData={playerData} />
                  {visibleChecklistGroups.length > 0 && (
                    <Table.Tr>
                      {playerData.map((player) => {
                        const traits = combinedTraitsByPlayer.get(player.actorIndex) ?? [];

                        return (
                          <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                            <Text size="xs" fw={700}>
                              {t("ui.player-checklist")}
                            </Text>
                            {visibleChecklistGroups.map((group) => (
                              <Box key={group.id}>
                                <Text size="xs" fw={600} c="dimmed" mt={4}>
                                  {checklistGroupName(group)}
                                </Text>
                                {group.kind === "computed"
                                  ? COMPUTED_SIGIL_ROWS.map(({ label, categories }) => (
                                      <SigilCategoryRow
                                        key={label}
                                        player={player}
                                        categories={categories}
                                        label={label}
                                      />
                                    ))
                                  : group.entries.map((entry) => (
                                      <ChecklistEntryRow
                                        key={entry.ids[0]}
                                        player={player}
                                        traits={traits}
                                        entry={entry}
                                      />
                                    ))}
                              </Box>
                            ))}
                          </Table.Td>
                        );
                      })}
                    </Table.Tr>
                  )}
                  <Table.Tr>
                    {playerData.map((player, playerIndex) => {
                      const findings = legality[playerIndex] ?? [];
                      const overmasteries = (player.overmasteryInfo?.overmasteries || []).filter(
                        (overmastery) => overmastery.value !== 0 || overmastery.flags !== 0
                      );
                      const summonBonuses = (player.summons ?? [])
                        .filter((summon) => summon.bonusId !== EMPTY_ID)
                        .sort((a, b) =>
                          translateSummonBonusId(a.bonusId).localeCompare(translateSummonBonusId(b.bonusId))
                        );
                      // Same-effect bonuses merged into one line each (an effect
                      // spans many ids across overmasteries and summon bonuses).
                      const combined = groupBonuses([
                        ...overmasteries.map((overmastery) => ({
                          name: translateOvermasteryId(overmastery.id),
                          source: {
                            kind: "overmastery" as const,
                            sourceId: overmastery.id,
                            value: overmasteryAmount(overmastery),
                          },
                        })),
                        ...summonBonuses.map((summon) => ({
                          name: translateSummonBonusId(summon.bonusId),
                          source: {
                            kind: "summon" as const,
                            sourceId: summon.summonId,
                            value: summonBonusValue(summon.bonusId, summon.bonusLevel) ?? {
                              kind: "level" as const,
                              amount: summon.bonusLevel + 1,
                            },
                          },
                        })),
                      ]);

                      // Every known effect, canonical order, so builds are easy to
                      // compare across players; effects at 0 render grayed out.
                      const allEffects = fillBonusGroups(combined, OVERMASTERY_EFFECT_IDS.map(translateOvermasteryId));

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          {/* Both whole-set reports land here: this row merges
                              overmasteries and summon equip bonuses into one
                              list BY EFFECT, so no row corresponds to a member
                              of either set and the heading is the only honest
                              place for the claim. `lines={[]}` says exactly
                              that — the shared marker then reddens the heading
                              of its own accord, by the same rule it uses
                              everywhere else. */}
                          <FlaggedGear
                            name={t("ui.player-overmasteries")}
                            lines={[]}
                            findings={[
                              ...findingsForSubject(findings, "overmasteries"),
                              ...findingsForSubject(findings, "summons"),
                            ]}
                            explain="tooltip"
                          />
                          <Placeholder empty={combined.length === 0}>
                            {allEffects.map((bonus) => (
                              <BonusRow key={bonus.name} bonus={bonus} />
                            ))}
                          </Placeholder>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player) => {
                      const traits = (combinedTraitsByPlayer.get(player.actorIndex) ?? [])
                        .map((trait) => ({ ...trait, name: translateTraitId(trait.id) }))
                        .sort((a, b) => a.name.localeCompare(b.name));

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-sigil-traits")}
                            {traits.length > 0 && ` (${traits.length})`}
                          </Text>
                          <Placeholder empty={traits.length === 0}>
                            {traits.map((trait) => (
                              <SigilTraitRow key={trait.id} trait={trait} />
                            ))}
                          </Placeholder>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <MasterTraitsRows
                    playerData={playerData}
                    legality={legality}
                    expandedTiers={expandedMasterTraitTiers}
                    expandedCategories={expandedMasterTraitCategories}
                    onToggleTier={toggleMasterTraitTier}
                    onToggleCategory={toggleMasterTraitCategory}
                    onToggleAll={setAllMasterTraitTiers}
                  />
                </Table.Tbody>
              </Table>
            </Group>
          </Tabs.Panel>
        </Tabs>
      </Box>
    </Box>
  );
};

type SkillboardNode = { text: string; unlocked: boolean; warn: boolean };

/// One branch (ATK/DEF/LIM) of a tier: its nodes plus the progress toward the
/// tier's activation threshold. `key` is null only for a node id whose
/// category can't be decoded (game-patch drift) — every shipped board node
/// resolves.
type SkillboardCategoryGroup = {
  key: SkillboardCategory | null;
  nodes: SkillboardNode[];
  /** Points spent in this branch of this tier. */
  spent: number;
  /** Points needed to activate it; 0 for EX, which has no threshold. */
  required: number;
};

type SkillboardTier = {
  key: number | "ex";
  /** Points spent across every branch of the tier. */
  spent: number;
  categories: SkillboardCategoryGroup[];
};

/// The character's full master-trait board grouped by tier (Chaos 1-3, then
/// EX) and, within each tier, by branch (ATK/DEF/LIM), with the player's
/// unlocked nodes flagged. Each branch is sorted unlocked first, then
/// unselected DMG Cap warnings, then alphabetically within each group.
/// Placement comes from the
/// game's skillboard_layout table (skillboard-layout.json) — the node id does
/// not encode the tier (the hundreds digit does encode the branch). Empty when
/// the player has no skillboard data at all (older logs, companions) so the
/// cell falls back to a placeholder instead of an all-unselected board.
function groupSkillboardNodes(player: PlayerData): { total: number; tiers: SkillboardTier[] } {
  const unlocked = player.skillboard ?? [];
  if (unlocked.length === 0) return { total: 0, tiers: [] };

  const unlockedIds = new Set(unlocked);
  const tiers = new Map<number | "ex", Map<SkillboardCategory | null, SkillboardNode[]>>();
  let total = 0;
  const push = (tierKey: number | "ex", id: number, isUnlocked: boolean) => {
    if (isUnlocked) total += 1;
    let tier = tiers.get(tierKey);
    if (!tier) tiers.set(tierKey, (tier = new Map()));
    const category = skillboardNodeMeta(id)?.category ?? null;
    let nodes = tier.get(category);
    if (!nodes) tier.set(category, (nodes = []));
    const text = translateSkillboardNode(player.characterType, id);
    // Unselected DMG Cap nodes are almost always a build mistake — flag them
    // like the checklist's warning state.
    nodes.push({ text, unlocked: isUnlocked, warn: !isUnlocked && text.includes("DMG Cap") });
  };

  const placed = new Set<number>();
  for (const layoutTier of skillboardLayoutFor(player.characterType)) {
    for (const id of layoutTier.ids) {
      placed.add(id);
      push(layoutTier.key, id, unlockedIds.has(id));
    }
  }
  // Unlocked ids the layout asset doesn't know (game-patch drift): place them
  // by the legacy id-band heuristic rather than dropping them.
  for (const id of unlockedIds) {
    if (placed.has(id)) continue;
    const meta = skillboardNodeMeta(id);
    if (!meta) continue;
    push(meta.tier, id, true);
  }

  const order = (key: number | "ex") => (key === "ex" ? Number.MAX_SAFE_INTEGER : key);
  return {
    total,
    tiers: [...tiers.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([key, byCategory]) => {
        const categories = [...byCategory.entries()]
          .sort((a, b) => categoryOrder(a[0]) - categoryOrder(b[0]))
          .map(([category, nodes]) => ({
            key: category,
            nodes: nodes.sort(
              (a, b) =>
                Number(b.unlocked) - Number(a.unlocked) ||
                Number(b.warn) - Number(a.warn) ||
                a.text.localeCompare(b.text)
            ),
            spent: nodes.filter((node) => node.unlocked).length,
            required: category === null ? 0 : skillboardActivationCost(key),
          }));

        return { key, categories, spent: categories.reduce((sum, category) => sum + category.spent, 0) };
      }),
  };
}

/// Branch display order, with undecodable nodes (key null) trailing.
const categoryOrder = (key: SkillboardCategory | null) =>
  key === null ? SKILLBOARD_CATEGORIES.length : SKILLBOARD_CATEGORIES.indexOf(key);

/** Kills the table's zebra striping on a row — the master-traits rows read as
 * one section, not alternating table entries. */
const UNSTRIPED = { backgroundColor: "transparent" } as const;

/** The master-traits table rows, shared by the Equipment and Builds tabs.
 * Tiers render as their own rows spanning every player column so "Tier 2"
 * (and each trait line under it) starts at the same height for all players,
 * regardless of text wrapping or per-player trait counts. Each tier is
 * collapsible via the +/- toggle in its header row, and the section header's
 * own +/- expands or collapses every tier at once; the expanded set lives in
 * the page so toggling a tier expands/collapses it for every player at once. */
function MasterTraitsRows({
  playerData,
  legality,
  expandedTiers,
  expandedCategories,
  onToggleTier,
  onToggleCategory,
  onToggleAll,
}: {
  playerData: PlayerData[];
  /** Findings per player, aligned with `playerData`. */
  legality: LegalityFinding[][];
  /** Tiers and branches both start collapsed, so these hold the open ones. */
  expandedTiers: Set<string>;
  expandedCategories: Set<string>;
  onToggleTier: (tierId: string) => void;
  onToggleCategory: (categoryId: string) => void;
  onToggleAll: (tierIds: string[], expand: boolean) => void;
}) {
  const { i18n } = useTranslation();
  // Grouping walks every layout node through i18next per player — cache it so
  // tier expand/collapse and sort clicks don't redo it (node text is
  // language-dependent, hence the language dep).
  const grouped = useMemo(() => playerData.map((player) => groupSkillboardNodes(player)), [playerData, i18n.language]);
  const anyTraits = grouped.some((skillboard) => skillboard.total > 0);

  // Union of the players' tiers, in board order (Chaos 1-3, then EX).
  const tierOrder = (key: number | "ex") => (key === "ex" ? Number.MAX_SAFE_INTEGER : key);
  const tierKeys = [...new Set(grouped.flatMap((skillboard) => skillboard.tiers.map((tier) => tier.key)))].sort(
    (a, b) => tierOrder(a) - tierOrder(b)
  );
  const allExpanded = tierKeys.length > 0 && tierKeys.every((tierKey) => expandedTiers.has(String(tierKey)));

  const rows: JSX.Element[] = [];
  for (const tierKey of tierKeys) {
    const perPlayerTier = grouped.map((skillboard) => skillboard.tiers.find((tier) => tier.key === tierKey));
    const tierId = String(tierKey);
    const expanded = expandedTiers.has(tierId);

    rows.push(
      <Table.Tr key={`tier-${tierKey}`} style={UNSTRIPED}>
        {perPlayerTier.map((tier, playerIndex) => (
          <Table.Td key={playerData[playerIndex].actorIndex} style={{ verticalAlign: "top" }}>
            {tier && (
              <UnstyledButton onClick={() => onToggleTier(tierId)}>
                {/* Brighter than the dimmed branch rows under it, dimmer than
                    the section header above it — the middle rung of the three. */}
                <Text size="xs" fw={600} c="gray.5" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {expanded ? <Minus size="0.7rem" weight="bold" /> : <Plus size="0.7rem" weight="bold" />}
                  {tierKey === "ex" ? t("ui.master-traits.ex") : t("ui.master-traits.tier", { tier: tierKey })} (
                  {tier.spent})
                </Text>
              </UnstyledButton>
            )}
          </Table.Td>
        ))}
      </Table.Tr>
    );

    if (!expanded) continue;

    // Union of the players' branches so every player's ATK block starts on the
    // same row, exactly like the tier rows above.
    const categoryKeys = [
      ...new Set(perPlayerTier.flatMap((tier) => tier?.categories.map((category) => category.key) ?? [])),
    ].sort((a, b) => categoryOrder(a) - categoryOrder(b));

    for (const categoryKey of categoryKeys) {
      const perPlayerCategory = perPlayerTier.map((tier) =>
        tier?.categories.find((category) => category.key === categoryKey)
      );
      const categoryId = `${tierId}:${categoryKey ?? "other"}`;
      const categoryExpanded = expandedCategories.has(categoryId);

      rows.push(
        <Table.Tr key={`tier-${tierKey}-cat-${categoryKey ?? "other"}`} style={UNSTRIPED}>
          {perPlayerCategory.map((category, playerIndex) => (
            <Table.Td key={playerData[playerIndex].actorIndex} style={{ verticalAlign: "top" }}>
              {category && (
                <CategoryHeader
                  category={category}
                  expanded={categoryExpanded}
                  onToggle={() => onToggleCategory(categoryId)}
                />
              )}
            </Table.Td>
          ))}
        </Table.Tr>
      );

      if (!categoryExpanded) continue;

      const maxNodes = Math.max(...perPlayerCategory.map((category) => category?.nodes.length ?? 0));
      for (let nodeIndex = 0; nodeIndex < maxNodes; nodeIndex++) {
        rows.push(
          <Table.Tr key={`tier-${tierKey}-cat-${categoryKey ?? "other"}-node-${nodeIndex}`} style={UNSTRIPED}>
            {perPlayerCategory.map((category, playerIndex) => {
              const node = category?.nodes[nodeIndex];

              return (
                <Table.Td key={playerData[playerIndex].actorIndex} style={{ verticalAlign: "top" }}>
                  <Placeholder empty={!node}>
                    {node && (
                      <Text
                        size="xs"
                        fw={300}
                        c={node.unlocked ? "teal" : node.warn ? "orange" : undefined}
                        style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 }}
                      >
                        {node.warn ? (
                          <Warning size="0.7rem" weight="bold" style={{ flexShrink: 0 }} />
                        ) : (
                          // Kept invisible when locked so the text stays aligned.
                          <Check
                            size="0.7rem"
                            weight="bold"
                            style={{ opacity: node.unlocked ? 1 : 0, flexShrink: 0 }}
                          />
                        )}
                        {node.text}
                      </Text>
                    )}
                  </Placeholder>
                </Table.Td>
              );
            })}
          </Table.Tr>
        );
      }
    }
  }

  return (
    <>
      <Table.Tr style={UNSTRIPED}>
        {playerData.map((player, playerIndex) => {
          const rawLabel =
            t("ui.player-master-traits") + (grouped[playerIndex].total > 0 ? ` (${grouped[playerIndex].total})` : "");
          // The count rule's claim is about the SET's size, so the section
          // header is the only honest place to put it — no single node is at
          // fault.
          const label = (
            <LegalityMark findings={findingsForSubject(legality[playerIndex] ?? [], "masterTraits")}>
              {rawLabel}
            </LegalityMark>
          );

          return (
            <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
              {anyTraits ? (
                <Group justify="space-between" wrap="nowrap" gap={8} align="center">
                  <UnstyledButton onClick={() => onToggleAll(tierKeys.map(String), !allExpanded)}>
                    <Text size="xs" fw={700} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {allExpanded ? <Minus size="0.7rem" weight="bold" /> : <Plus size="0.7rem" weight="bold" />}
                      {label}
                    </Text>
                  </UnstyledButton>
                  <ActivationSummary tiers={grouped[playerIndex].tiers} characterType={player.characterType} />
                </Group>
              ) : (
                <>
                  <Text size="xs" fw={700}>
                    {label}
                  </Text>
                  <Placeholder empty />
                </>
              )}
            </Table.Td>
          );
        })}
      </Table.Tr>
      {rows}
    </>
  );
}

const CATEGORY_LABEL_KEY: Record<SkillboardCategory | "other", string> = {
  atk: "ui.master-traits.category.atk",
  def: "ui.master-traits.category.def",
  lim: "ui.master-traits.category.lim",
  other: "ui.master-traits.category.other",
};

const CATEGORY_INITIAL_KEY: Record<SkillboardCategory, string> = {
  atk: "ui.master-traits.initial.atk",
  def: "ui.master-traits.initial.def",
  lim: "ui.master-traits.initial.lim",
};

/** The whole board at a glance, for the section header: a column per branch
 * (E/I/C) holding one pip per Chaos tier, filled where that branch's
 * activation threshold is met. EX carries no threshold, so it has no pip. */
function ActivationSummary({ tiers, characterType }: { tiers: SkillboardTier[]; characterType: CharacterType }) {
  return (
    <Group gap={10} wrap="nowrap">
      {SKILLBOARD_CATEGORIES.map((key) => {
        const activated = tiers
          .map((tier) => tier.categories.find((category) => category.key === key))
          .filter((category) => category !== undefined && category.required > 0)
          .map((category) => category!.spent >= category!.required);
        if (activated.length === 0) return null;
        // Every tier of the branch activated — the letter joins its pips.
        const fullySpecced = activated.every(Boolean);

        return (
          <Stack key={key} gap={2} align="center">
            <Tooltip label={translateSkillboardBranch(characterType, key, CATEGORY_LABEL_KEY[key])} withArrow>
              <Text size="xs" fw={700} lh={1} c={fullySpecced ? PIP_SPENT_EDGE : "dimmed"}>
                {t(CATEGORY_INITIAL_KEY[key])}
              </Text>
            </Tooltip>
            <Group gap={4} wrap="nowrap">
              {activated.map((isActivated, index) => (
                <PointDiamond key={index} filled={isActivated} />
              ))}
            </Group>
          </Stack>
        );
      })}
    </Group>
  );
}

/** One branch of one tier: a toggle for its node list, its name, and a pip per
 * point needed to activate the branch's tier bonus, filled up to what the
 * player actually spent. EX has no activation threshold, so it shows a plain
 * count instead of pips. */
function CategoryHeader({
  category,
  expanded,
  onToggle,
}: {
  category: SkillboardCategoryGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const activated = category.required > 0 && category.spent >= category.required;

  return (
    <UnstyledButton onClick={onToggle} style={{ display: "block", width: "100%" }}>
      {/* The pips sit flush against the column's right edge so they line up
          into a single column across the branches, whose names vary in width. */}
      <Group gap={8} wrap="nowrap" justify="space-between" style={{ paddingLeft: 10 }}>
        <Text
          size="xs"
          fw={600}
          c={activated ? PIP_SPENT_EDGE : "dimmed"}
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          {expanded ? <Minus size="0.7rem" weight="bold" /> : <Plus size="0.7rem" weight="bold" />}
          {t(CATEGORY_LABEL_KEY[category.key ?? "other"])}
        </Text>
        {category.required > 0 ? (
          <Group gap={5} wrap="nowrap">
            {Array.from({ length: category.required }, (_, index) => (
              <PointDiamond key={index} filled={index < category.spent} />
            ))}
          </Group>
        ) : (
          <Text size="xs" fw={400} c="dimmed">
            ({category.spent})
          </Text>
        )}
      </Group>
    </UnstyledButton>
  );
}

// The master-trait pip palette. The edge color doubles as the highlight for
// labels that echo their pips (an activated branch, a fully specced letter).
const PIP_SPENT = "#c026d3";
const PIP_SPENT_EDGE = "#f0abfc";
const PIP_EMPTY = "#101014";
const PIP_EMPTY_EDGE = "#4c5fd7";

/** A spent master-trait point (filled pink/purple) or one still missing before
 * the branch activates (purple-blue outline on near-black). */
function PointDiamond({ filled }: { filled: boolean }) {
  return (
    <Box
      component="span"
      style={{
        width: 6,
        height: 6,
        flexShrink: 0,
        transform: "rotate(45deg)",
        border: `1px solid ${filled ? PIP_SPENT_EDGE : PIP_EMPTY_EDGE}`,
        backgroundColor: filled ? PIP_SPENT : PIP_EMPTY,
        boxShadow: filled ? "0 0 4px rgba(217, 70, 239, 0.55)" : "none",
      }}
    />
  );
}

function Placeholder({ empty, children }: { empty: boolean; children?: React.ReactNode }) {
  return empty ? (
    <Text size="xs" fw={300}>
      ---
    </Text>
  ) : (
    children
  );
}
