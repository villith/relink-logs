import { AreaChart, LineChart } from "@mantine/charts";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Group,
  Menu,
  MultiSelect,
  NumberFormatter,
  Paper,
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
import { Link, useParams } from "react-router-dom";

import { ColumnsPopover } from "@/components/ColumnsPopover";
import { Table as MeterTable } from "@/components/Table";
import { useChecklistStore } from "@/stores/useChecklistStore";
import { EncounterStateResponse, useEncounterStore } from "@/stores/useEncounterStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  MeterColumns,
  type ComputedPlayerState,
  type EncounterState,
  type Overmastery,
  type PlayerData,
  type SortDirection,
  type SortType,
} from "@/types";
import {
  EMPTY_ID,
  OVERMASTERY_EFFECT_IDS,
  PLAYER_COLORS,
  SIGIL_CATEGORY_TARGET,
  checklistLevel,
  checklistStatus,
  collectSigilsByCategory,
  collectTraitSources,
  computeCombinedTraits,
  deriveTranscendence,
  epochToLocalTime,
  exportCharacterDataToClipboard,
  exportFullEncounterToClipboard,
  exportScreenshotToClipboard,
  exportSimpleEncounterToClipboard,
  fillBonusGroups,
  formatCharacterLabel,
  formatInPartyOrder,
  formatSummonBonusValue,
  groupBonuses,
  humanizeNumbers,
  millisecondsToElapsedFormat,
  openDamageCalculator,
  resolvePlayerColor,
  skillboardLayoutFor,
  skillboardNodeMeta,
  summonBonusValue,
  targetLabelKey,
  toHash,
  toHashString,
  traitMaxLevel,
  translateAbilityId,
  translateEnemyType,
  translateItemId,
  translateOvermasteryId,
  translateQuestId,
  translateSigilId,
  translateSkillboardNode,
  translateSummonBonusId,
  translateSummonId,
  translateTraitId,
  translateWeaponId,
  translateWeaponKey,
  translatedPlayerName,
  weaponInnateTraits,
  type BonusAmount,
  type BonusSource,
  type ChecklistEntry,
  type ChecklistStatus,
  type CombinedBonus,
  type CombinedTrait,
  type SigilCategory,
  type TraitSource,
  type WeaponTraitDef,
} from "@/utils";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

type Label = { name: string; partySlotIndex: number; label?: string; color: string; strokeDasharray?: string }[];

// The single-bit level flag (bit N → level N+1) → a 1-based level, or 0 if unset.
// `>>> 0` forces the isolated bit to an unsigned value so a set bit 31 can't make
// `flags & -flags` negative and yield `Math.log2(negative) === NaN`.
const overmasteryLevel = (flags: number): number => (flags === 0 ? 0 : Math.log2((flags & -flags) >>> 0) + 1);

// Overmastery ids whose value is a flat stat amount; all others display as percentages.
const OVERMASTERY_FLAT_VALUE_IDS = [
  0x032a5217, 0x0781c7a2, 0x0b134a7f, 0x0cf5d0f3, 0x0db88f30, 0x0f25b474, 0x0febc993, 0x11023c6f, 0x124db819,
  0x1268b903, 0x13c9452a, 0x155c25c3, 0x1cc2f730, 0x1e2b3db5, 0x24499a25, 0x254a08d4, 0x2d6c03eb, 0x2ea457f3,
  0x303becc0, 0x3526fecb, 0x38f656e7, 0x394083bd, 0x3ac53494, 0x3ca4c8d5, 0x3d6600d9, 0x403be586, 0x409df671,
  0x427b5e26, 0x437c055d, 0x44f04a7a, 0x49089d4f, 0x4ab91ea7, 0x4c0cbd32, 0x4ce64874, 0x4e2513df, 0x52a207b5,
  0x5382923d, 0x53d358e0, 0x5767dd9f, 0x57bbc478, 0x59dce1e8, 0x5a51f0cb, 0x5a57dc07, 0x60835d4f, 0x60926b53,
  0x61d4efa0, 0x6564c02b, 0x66092bc7, 0x67bde89b, 0x6e4f2f5e, 0x6fb47781, 0x7125942e, 0x7cbbb4e0, 0x7ccf98c5,
  0x7e870ebe, 0x807e9e58, 0x829b8b5c, 0x834892b4, 0x85f0f318, 0x871d12cc, 0x874353d7, 0x8af65803, 0x8e66b68c,
  0x8fe7fb0a, 0x911d4f18, 0x91265f66, 0x93572974, 0x937efb96, 0x95567556, 0x9a0988df, 0x9a29aa64, 0x9b6f164c,
  0x9bfd4548, 0x9c6375cf, 0xa1dc63b3, 0xa257dac1, 0xa2bcf523, 0xa3460028, 0xa85b4af5, 0xaac23948, 0xab56bde3,
  0xaccbece1, 0xaf0d8b97, 0xb83aa115, 0xbbe7992a, 0xbd488071, 0xbe8c17d4, 0xbf44c20b, 0xc1360291, 0xc265b03b,
  0xc2d708c1, 0xc4925bd7, 0xc52d2245, 0xc5d68c62, 0xc6bdc7a6, 0xcb43ff8e, 0xcb63be55, 0xcb6bb434, 0xccef4492,
  0xcd5d6315, 0xcf24e1a2, 0xcf6b267a, 0xd51958d1, 0xda546dfe, 0xdcbd8423, 0xddc29837, 0xde6a367a, 0xdf2cab83,
  0xdf2eef09, 0xdfb00115, 0xe056ba80, 0xe7710898, 0xea5eaafc, 0xea99fa76, 0xee6100ca, 0xeefb4ade, 0xf004e9f2,
  0xf203bb15, 0xf2111b99, 0xf5514f81, 0xf80e3310, 0xfa230938, 0xfa9bcf64, 0xfb276afd, 0xfe71865d, 0x2676f9d2,
  0x2c1c933d, 0x3356dd03, 0x36f068fd, 0x3dae6494, 0x455d6a1c, 0x59fbb7d8, 0x6837e60c, 0x6cb38ef3, 0x7b05e679,
  0x7b498c32, 0x9bf7878a, 0xa3545ca1, 0xa85495ba, 0xa901e065, 0xc11fdfbd, 0xd5169339, 0xd63dd12b, 0xf5c314a0,
];

// v2.0.2: overmasteries recovered from the town loadout carry only id + level
// (in `flags`), not the computed in-game magnitude (`value` is 0) — fall back
// to the level, matching the "(Lvl. N)" style used for sigils and summons.
const overmasteryAmount = (overmastery: Overmastery): BonusAmount =>
  overmastery.value === 0
    ? { kind: "level", amount: overmasteryLevel(overmastery.flags) }
    : {
        kind: OVERMASTERY_FLAT_VALUE_IDS.includes(overmastery.id) ? "flat" : "percent",
        amount: overmastery.value,
      };

const formatOvermastery = (overmastery: Overmastery | undefined): string => {
  if (!overmastery) return "";
  const translation = translateOvermasteryId(overmastery.id);
  const amount = overmasteryAmount(overmastery);
  return amount.kind === "level"
    ? `${translation} ${formatBonusAmount(amount)}`
    : `${translation}: ${formatBonusAmount(amount)}`;
};

const formatBonusAmount = (value: BonusAmount): string =>
  value.kind === "level"
    ? `(Lvl. ${value.amount})`
    : `+${Number(value.amount.toFixed(2))}${value.kind === "percent" ? "%" : ""}`;

// "+1800 (Lvl. 3)" — numeric totals first, with any magnitude-unknown
// (level-only) contributions trailing. Totals arrive in that order already.
const formatBonusTotals = (totals: BonusAmount[]): string => totals.map(formatBonusAmount).join(" ");

const formatPlayerDisplayName = (player: PlayerData, showName: boolean, showLevel: boolean = true): string => {
  const label = formatCharacterLabel(player.characterType, player.displayName, showName);

  return showLevel ? `${label} Lvl. ${player.playerStats?.level || 1}` : label;
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

interface ChartTooltipProps {
  label: string;
  payload: Record<string, any>[] | undefined; // eslint-disable-line
  /** Overrides the plain thousands-separated rendering (the HP chart shows percentages).
   * Mantine's own `valueFormatter` cannot reach a custom `content`, so it is passed here. */
  formatValue?: (value: number) => string;
}

export const ChartTooltip = ({ label, payload, formatValue }: ChartTooltipProps) => {
  if (!payload) return null;

  const format = formatValue ?? ((value: number) => new Intl.NumberFormat("en-US").format(value));

  return (
    <Paper px="md" py="sm" withBorder shadow="md" radius="md">
      <Text fw={500} mb={5}>
        {label}
      </Text>
      {/* A null datapoint means "no data here" (e.g. an HP pool that hasn't
          spawned yet or is already dead) — not a zero; leave it out. */}
      {payload
        .filter((item) => item.value !== null && item.value !== undefined)
        .map(
          (
            item: any // eslint-disable-line
          ) => (
            <Text key={item.name} fz="sm">
              <Text component="span" c={item.color}>
                {item.name === "party" ? t("ui.logs.damage-per-second") : item.name}
              </Text>
              : {format(item.value)}
            </Text>
          )
        )}
    </Paper>
  );
};

// Chart buckets are one second wide (the backend's DPS_INTERVAL), so a bucket
// index IS the elapsed second. Every bucket-index↔milliseconds conversion must
// go through this constant — a silent `* 1000` breaks if the width changes.
const DPS_BUCKET_MS = 1000;

// DPS points are smoothed with a trailing moving average this many seconds wide.
const DPS_SMOOTHING_WINDOW = 10;

// Chart geometry pinned so the overview brush can span exactly the plot area:
// recharts margin (5px each side) + y-axis width, matched by the brush insets.
const CHART_MARGIN = 5;
const CHART_Y_AXIS_WIDTH = 60;

type ChartDatapoint = {
  timestamp?: string;
  party?: number;
} & { [key: string]: number };

type HpDatapoint = { timestamp?: string; [key: string]: string | number | null | undefined };

/** Fixed categorical order for the enemy HP lines: the boss (largest pool) is
 * always the first, red; extra pools (summon waves count individually, up to
 * the backend's 12-series cap) follow in pool-size order. */
const HP_SERIES_COLORS = [
  "red.6",
  "cyan.6",
  "yellow.6",
  "grape.6",
  "lime.6",
  "indigo.6",
  "orange.6",
  "teal.6",
  "pink.6",
  "blue.6",
  "green.6",
  "violet.6",
];

const MemoMeterTable = memo(MeterTable);

/** The zoomable detail charts (enemy HP% strip + per-player DPS). Memoized so
 * brush drags — which re-render the page on every pointer move — skip these
 * expensive recharts trees until a window is actually committed. */
const mantineColorVar = (color: string) => `var(--mantine-color-${color.replace(".", "-")})`;

const DetailCharts = memo(function DetailCharts({
  data,
  hpData,
  hpSeries,
  hiddenHpSeries,
  onToggleHpSeries,
  labels,
}: {
  data: ChartDatapoint[];
  hpData: HpDatapoint[];
  hpSeries: { name: string; color: string }[];
  hiddenHpSeries: Set<string>;
  onToggleHpSeries: (name: string) => void;
  labels: Label;
}) {
  // Our own legend chips instead of the recharts legend: they toggle lines
  // on/off, and they wrap ABOVE the chart instead of into the plot area on
  // summon-heavy fights. Hidden series leave the plot and the tooltip alike.
  const visibleHpSeries = hpSeries.filter((series) => !hiddenHpSeries.has(series.name));

  return (
    <>
      {hpSeries.length > 0 && (
        <>
          <Group gap="xs" align="center">
            <Text size="sm">{t("ui.logs.enemy-hp")}</Text>
            {hpSeries.length > 1 &&
              hpSeries.map((series) => {
                const hidden = hiddenHpSeries.has(series.name);
                return (
                  <UnstyledButton
                    key={series.name}
                    onClick={() => onToggleHpSeries(series.name)}
                    style={{ opacity: hidden ? 0.4 : 1 }}
                  >
                    <Group gap={4} wrap="nowrap">
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          flexShrink: 0,
                          display: "inline-block",
                          background: mantineColorVar(series.color),
                        }}
                      />
                      <Text size="xs" td={hidden ? "line-through" : undefined}>
                        {series.name}
                      </Text>
                    </Group>
                  </UnstyledButton>
                );
              })}
          </Group>
          <LineChart
            h={hpSeries.length > 1 ? 180 : 120}
            data={hpData}
            dataKey="timestamp"
            withDots={false}
            connectNulls
            series={visibleHpSeries}
            yAxisProps={{ domain: [0, 100], width: CHART_Y_AXIS_WIDTH }}
            xAxisProps={{ interval: "preserveStartEnd" }}
            valueFormatter={(value) => `${value.toFixed(1)}%`}
            lineChartProps={{
              syncId: "quest-details",
              margin: { top: CHART_MARGIN, right: CHART_MARGIN, bottom: CHART_MARGIN, left: CHART_MARGIN },
            }}
            tooltipProps={{
              // The synced DPS tooltip renders at the same instant right below;
              // a tall HP tooltip must stack above it, not slide behind it.
              wrapperStyle: { zIndex: 20 },
              // Mantine spreads `tooltipProps` AFTER its own `content`, so this replaces
              // the built-in tooltip outright and `valueFormatter` never reaches it — the
              // formatter above only styles the y-axis ticks. Format here too, or the
              // percentages render as bare floats next to raw DPS numbers.
              content: ({ label, payload }) => (
                <ChartTooltip label={label} payload={payload} formatValue={(value) => `${value.toFixed(1)}%`} />
              ),
            }}
          />
        </>
      )}
      <Text size="sm">{t("ui.logs.damage-per-second")}</Text>
      <LineChart
        h={400}
        data={data}
        dataKey="timestamp"
        withDots={false}
        withLegend
        series={labels}
        valueFormatter={(value) => {
          const [num, suffix] = humanizeNumbers(value);
          return `${num}${suffix}`;
        }}
        yAxisProps={{ width: CHART_Y_AXIS_WIDTH }}
        xAxisProps={{ interval: "preserveStartEnd" }}
        lineChartProps={{
          syncId: "quest-details",
          margin: { top: CHART_MARGIN, right: CHART_MARGIN, bottom: CHART_MARGIN, left: CHART_MARGIN },
        }}
        tooltipProps={{
          wrapperStyle: { zIndex: 10 }, // below the HP tooltip when they meet
          content: ({ label, payload }) => <ChartTooltip label={label} payload={payload} />,
        }}
      />
    </>
  );
});

/** The full-fight context strip the brush rides on: a quiet party-DPS area.
 * Memoized for the same drag-performance reason as the detail charts. */
const OverviewChart = memo(function OverviewChart({ data }: { data: { timestamp?: string; party?: number }[] }) {
  return (
    <AreaChart
      h={56}
      data={data}
      dataKey="timestamp"
      series={[{ name: "party", color: "gray.6" }]}
      withDots={false}
      withXAxis={false}
      withYAxis={false}
      withTooltip={false}
      gridAxis="none"
      fillOpacity={0.4}
      areaChartProps={{ margin: { top: 2, right: 0, bottom: 0, left: 0 } }}
    />
  );
});

/** Dims the parts of the overview strip outside the selected window; follows
 * the handles live during a drag. */
const brushShade = (side: "left" | "right", widthPercent: number): React.CSSProperties => ({
  position: "absolute",
  top: 0,
  bottom: 0,
  [side]: 0,
  width: `${Math.max(0, Math.min(100, widthPercent))}%`,
  background: "rgba(10, 10, 10, 0.55)",
  pointerEvents: "none",
});

// Tooltip grouping for the checklist source breakdown, in display order.
const CHECKLIST_SOURCE_KINDS: { key: TraitSource["kind"]; label: string; translate: (id: number) => string }[] = [
  { key: "sigil", label: "ui.player-sigils", translate: translateSigilId },
  { key: "summon", label: "ui.player-summons", translate: translateSummonId },
  { key: "wrightstone", label: "ui.wrightstone", translate: translateItemId },
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
                - {kind.translate(source.sourceId)} (Lvl. {source.level})
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
              - {translateSigilId(sigil.sigilId)} (Lvl. {sigil.sigilLevel})
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

const byTraitName = (a: ChecklistEntry, b: ChecklistEntry) =>
  translateTraitId(a.ids[0]).localeCompare(translateTraitId(b.ids[0]));

export const ViewPage = () => {
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
  const { checklistBuild, checklistAi } = useChecklistStore(
    useShallow((state) => ({ checklistBuild: state.build, checklistAi: state.ai }))
  );
  const { t, i18n } = useTranslation();
  const { id } = useParams();

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
    questCompleted,
    roomIndex,
    playerData,
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
    questId: state.questId,
    questCompleted: state.questCompleted,
    roomIndex: state.roomIndex,
    setSelectedTargetSpans: state.setSelectedTargetSpans,
    loadFromResponse: state.loadFromResponse,
  }));
  // Builds tab: the combined traits scan all of a player's equipment, and two
  // rows (checklist + sigil traits) need them — computed once per player here.
  const combinedTraitsByPlayer = useMemo(
    () => new Map(playerData.map((player) => [player.actorIndex, computeCombinedTraits(player)])),
    [playerData]
  );
  // The enabled checklist entries are the same for every player column — filter
  // and sort them once per render instead of once per player.
  const buildEntries = checklistBuild.filter((entry) => entry.enabled).sort(byTraitName);
  const aiEntries = checklistAi.filter((entry) => entry.enabled).sort(byTraitName);

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
  // Shared so toggling a master-trait tier expands/collapses it for every player column.
  const [expandedMasterTraitTiers, setExpandedMasterTraitTiers] = useState<Set<number | "ex">>(new Set());
  const toggleMasterTraitTier = useCallback((tierKey: number | "ex") => {
    setExpandedMasterTraitTiers((previous) => {
      const next = new Set(previous);
      if (next.has(tierKey)) {
        next.delete(tierKey);
      } else {
        next.add(tierKey);
      }
      return next;
    });
  }, []);
  const setAllMasterTraitTiers = useCallback((tierKeys: (number | "ex")[], expand: boolean) => {
    setExpandedMasterTraitTiers(expand ? new Set(tierKeys) : new Set());
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
    invoke("fetch_encounter_state", { id: Number(id), options: { targetSpans: selectedTargetSpans } })
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
  }, [id, selectedTargetSpans]);

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
    [id, selectedTargetSpans, chartLen]
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
        ...(range ? { fromMs: range[0] * DPS_BUCKET_MS, upToMs: (range[1] + 1) * DPS_BUCKET_MS - 1 } : {}),
      },
    });
  }, [id, selectedTargetSpans, range]);

  // Display labels for every target spawn segment, keyed by
  // `${name}#${instance}` — shared by the HP-chart legend and the target-filter
  // dropdown (the game names summon INSTANCES individually, but only the type
  // is in the data). Same-name entries (summon waves, sibling adds) get their
  // instance suffix so each keeps its own identity; when one name additionally
  // spans different pool sizes (Lucilius' 141m vs 49m swords), the pool size is
  // the only distinguisher we have, so show it. Computed ONCE from
  // targetEntries (the dropdown's superset population) and looked up by the
  // chart, so the two UIs can never disagree on a label.
  const targetLabels = useMemo(() => {
    const countsByName = new Map<string, number>();
    const maxesByName = new Map<string, Set<number>>();
    for (const entry of targetEntries) {
      const name = translateEnemyType(entry.enemyType);
      countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
      if (entry.maxHp !== null) {
        (maxesByName.get(name) ?? maxesByName.set(name, new Set()).get(name)!).add(entry.maxHp);
      }
    }

    // The "#n" shown to the user counts within the NAME, not within the type hash.
    // `entry.instance` is per-type, so two types that translate to the same name would
    // both be "#1" — and since the chart uses the label as its series key, one pool's
    // line would overwrite the other's. targetEntries is in first-hit order, so these
    // ordinals stay chronological.
    const ordinalsByName = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const entry of targetEntries) {
      const name = translateEnemyType(entry.enemyType);
      const ordinal = (ordinalsByName.get(name) ?? 0) + 1;
      ordinalsByName.set(name, ordinal);

      let label = name;
      if ((countsByName.get(name) ?? 0) > 1) {
        label = `${name} #${ordinal}`;
        if ((maxesByName.get(name)?.size ?? 0) > 1 && entry.maxHp !== null) {
          const [max, maxUnit] = humanizeNumbers(entry.maxHp);
          label = `${label} (${max}${maxUnit})`;
        }
      }
      labels.set(targetLabelKey(entry.enemyType, entry.instance), label);
    }
    return labels;
    // `i18n.language` re-derives the labels on language change — the translate
    // helper reads the module-level i18n instance.
  }, [targetEntries, i18n.language]);

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
          <Link to="/logs">{t("ui.back-btn")}</Link>
        </Text>
        <Divider my="sm" />
        <Text>Loading...</Text>
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
            <Button size="xs" variant="default" component={Link} to="/logs">
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
        <Box>
          {roomIndex !== null && (
            <Box display="flex">
              <Text size="sm" fw={800}>
                {t("ui.logs.conflux-room", "Conflux Room")}:
              </Text>
              <Text size="sm" ml={4}>
                #{roomIndex + 1}
              </Text>
            </Box>
          )}
          {!!questId && roomIndex === null && (
            <Box display="flex">
              <Text size="sm" fw={800}>
                {t("ui.logs.quest-name")}:
              </Text>
              <Text size="sm" ml={4}>
                {translateQuestId(questId)} ({toHash(questId)}){" "}
              </Text>
            </Box>
          )}
          {!!questId && roomIndex === null && (
            <Box display="flex">
              <Text size="sm" fw={800}>
                {t("ui.logs.quest-status")}:
              </Text>
              <Text size="sm" fs="italic" ml={4}>
                {questCompleted ? "✅" : "❌"}
              </Text>
            </Box>
          )}
          <Box display="flex">
            <Text size="sm" fw={800}>
              {t("ui.logs.date")}:
            </Text>
            <Text size="sm" fs="italic" ml={4}>
              {epochToLocalTime(encounter.startTime)}
            </Text>
          </Box>
          <Box display="flex">
            <Text size="sm" fw={800}>
              {t("ui.logs.duration")}:
            </Text>
            <Text size="sm" fs="italic" ml={4}>
              {millisecondsToElapsedFormat(encounter.endTime - encounter.startTime)}
            </Text>
          </Box>
          <Box display="flex">
            <Text size="sm" fw={800}>
              {t("ui.logs.total-damage")}:
            </Text>
            <Text size="sm" fs="italic" ml={4}>
              <NumberFormatter thousandSeparator value={encounter.totalDamage} />
            </Text>
          </Box>
        </Box>

        <Divider my="sm" />

        <Tabs defaultValue="overview" variant="outline" keepMounted={false}>
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
                  placeholder="All"
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
                    {playerData.map((player) => {
                      return (
                        <Table.Td key={player.actorIndex} flex={1}>
                          <Flex direction="row" wrap="nowrap" align="center">
                            <Text fw={700} size="xl" mr="5">
                              {formatPlayerDisplayName(player, show_display_names && !streamer_mode, false)}
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
                            {t("ui.stats.level")}: {player.playerStats?.level || 1}
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
                    {playerData.map((player) => {
                      const overmasteries = player.overmasteryInfo?.overmasteries || [];

                      return (
                        <Table.Td key={player.actorIndex}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-overmasteries")}
                          </Text>
                          {Array.from(Array(4).keys()).map((overmasteryIndex) => {
                            const overmastery = overmasteries[overmasteryIndex];

                            return (
                              <Placeholder
                                key={overmasteryIndex}
                                empty={!overmastery || (overmastery.value === 0 && overmastery.flags === 0)}
                              >
                                <Text size="xs" fs="italic" fw={300}>
                                  {formatOvermastery(overmastery)}
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
                    {playerData.map((player) => {
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
                                {t([`weapons:${toHashString(player.weaponState.weaponId)}.text`, "ui.unknown-id"], {
                                  id: toHashString(player.weaponState.weaponId),
                                })}{" "}
                                +{player.weaponState.plusMarks}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                Awakening {player.weaponState.awakeningLevel}/10
                              </Text>
                              {(() => {
                                /* Derived from the innate skill levels vs the per-stage
                                   curves — needs a log recorded with level data. */
                                const stage = deriveTranscendence(
                                  player.weaponState.weaponId,
                                  player.weaponState.innateTraits
                                );
                                return stage !== null ? (
                                  <Text size="xs" fs="italic" fw={300}>
                                    Transcendence {stage}/10
                                  </Text>
                                ) : null;
                              })()}
                              {player.weaponState.innateTraits.map((trait) => (
                                <Text size="xs" fs="italic" fw={300} key={trait.id}>
                                  - {translateTraitId(trait.id)}
                                  {trait.level > 0 ? ` (Lvl. ${trait.level})` : ""}
                                </Text>
                              ))}
                              {player.weaponState.wrightstoneId > 0 && (
                                <>
                                  <Text size="xs" fw={700}>
                                    {t([
                                      `items:${toHashString(player.weaponState.wrightstoneId)}.text`,
                                      "ui.wrightstone",
                                    ])}
                                  </Text>
                                  {player.weaponState.wrightstoneTraits.map((trait) => (
                                    <Text size="xs" fs="italic" fw={300} key={trait.id}>
                                      - {translateTraitId(trait.id)}
                                      {trait.level > 0 ? ` (Lvl. ${trait.level})` : ""}
                                    </Text>
                                  ))}
                                </>
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
                                {t([`weapons:${toHashString(player.weaponInfo?.weaponId)}.text`, "ui.unknown-id"], {
                                  id: toHashString(player.weaponInfo?.weaponId),
                                })}{" "}
                                +{player.weaponInfo?.plusMarks}
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                Awakening {player.weaponInfo?.awakeningLevel || 0}/10
                              </Text>
                              <Text size="xs" fs="italic" fw={300}>
                                Lvl {player.weaponInfo?.weaponLevel || 0} / ATK {player.weaponInfo?.weaponAttack || 0} /
                                HP {player.weaponInfo?.weaponHp || 0}
                              </Text>
                              <Text size="xs" fw={700}>
                                {translateItemId(player.weaponInfo?.wrightstoneId || EMPTY_ID)}
                              </Text>
                              <Placeholder empty={!player.weaponInfo?.trait1Id || player.weaponInfo?.trait1Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait1Id || EMPTY_ID)} (Lvl.{" "}
                                  {player.weaponInfo?.trait1Level})
                                </Text>
                              </Placeholder>
                              <Placeholder empty={!player.weaponInfo?.trait2Id || player.weaponInfo?.trait2Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait2Id || EMPTY_ID)} (Lvl.{" "}
                                  {player.weaponInfo?.trait2Level})
                                </Text>
                              </Placeholder>
                              <Placeholder empty={!player.weaponInfo?.trait3Id || player.weaponInfo?.trait3Level == 0}>
                                <Text size="xs" fs="italic" fw={300}>
                                  - {translateTraitId(player.weaponInfo?.trait3Id || EMPTY_ID)} (Lvl.{" "}
                                  {player.weaponInfo?.trait3Level})
                                </Text>
                              </Placeholder>
                            </>
                          )}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player) => {
                      const summons = player.summons ?? [];

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-summons")}
                          </Text>
                          <Placeholder empty={summons.length === 0}>
                            {summons.map((summon, summonIndex) => (
                              <Box key={summonIndex} mt={summonIndex > 0 ? 4 : 0}>
                                <Text size="xs" fw={600}>
                                  {translateSummonId(summon.summonId)}
                                </Text>
                                <Text size="xs" fs="italic" fw={300} pl={8}>
                                  - {translateTraitId(summon.mainTraitId)} (Lvl. {summon.mainTraitLevel})
                                </Text>
                                <Text size="xs" fs="italic" fw={300} pl={8}>
                                  - {translateSummonBonusId(summon.bonusId)}{" "}
                                  {formatSummonBonusValue(summon.bonusId, summon.bonusLevel) ??
                                    `(Lvl. ${summon.bonusLevel + 1})`}
                                </Text>
                              </Box>
                            ))}
                          </Placeholder>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <MasterTraitsRows
                    playerData={playerData}
                    expandedTiers={expandedMasterTraitTiers}
                    onToggleTier={toggleMasterTraitTier}
                    onToggleAll={setAllMasterTraitTiers}
                  />
                  <Table.Tr>
                    {playerData.map((player) => {
                      const sigils = (player.sigils ?? []).filter((sigil) => sigil.sigilId !== EMPTY_ID);

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-sigils")}
                            {sigils.length > 0 && ` (${sigils.length})`}
                          </Text>
                          <Placeholder empty={sigils.length === 0}>
                            {sigils.map((sigil, sigilIndex) => (
                              <Box key={sigilIndex} mt={sigilIndex > 0 ? 4 : 0}>
                                <Text size="xs" fw={600}>
                                  {translateSigilId(sigil.sigilId)} (Lvl. {sigil.sigilLevel})
                                </Text>
                                <Text size="xs" fs="italic" fw={300} pl={8}>
                                  - {translateTraitId(sigil.firstTraitId)} (Lvl. {sigil.firstTraitLevel})
                                </Text>
                                {sigil.secondTraitId !== EMPTY_ID && (
                                  <Text size="xs" fs="italic" fw={300} pl={8}>
                                    - {translateTraitId(sigil.secondTraitId)} (Lvl. {sigil.secondTraitLevel})
                                  </Text>
                                )}
                              </Box>
                            ))}
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
                    {playerData.map((player) => (
                      <Table.Td key={player.actorIndex} flex={1}>
                        <Text fw={700} size="xl">
                          {formatPlayerDisplayName(player, show_display_names && !streamer_mode, false)}
                        </Text>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                  <AbilitiesRow playerData={playerData} />
                  <Table.Tr>
                    {playerData.map((player) => {
                      const traits = combinedTraitsByPlayer.get(player.actorIndex) ?? [];

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-checklist")}
                          </Text>
                          {buildEntries.length > 0 && (
                            <>
                              <Text size="xs" fw={600} c="dimmed">
                                {t("ui.checklist.sigils")}
                              </Text>
                              {buildEntries.map((entry) => (
                                <ChecklistEntryRow key={entry.ids[0]} player={player} traits={traits} entry={entry} />
                              ))}
                            </>
                          )}
                          <Text size="xs" fw={600} c="dimmed" mt={4}>
                            {t("ui.checklist.computed")}
                          </Text>
                          <SigilCategoryRow player={player} categories={["basic"]} label="ui.checklist.basic-sigils" />
                          <SigilCategoryRow
                            player={player}
                            categories={["attack"]}
                            label="ui.checklist.attack-sigils"
                          />
                          <SigilCategoryRow
                            player={player}
                            categories={["defense", "support"]}
                            label="ui.checklist.defense-support-sigils"
                          />
                          {aiEntries.length > 0 && (
                            <>
                              <Text size="xs" fw={600} c="dimmed" mt={4}>
                                {t("ui.checklist.ai")}
                              </Text>
                              {aiEntries.map((entry) => (
                                <ChecklistEntryRow key={entry.ids[0]} player={player} traits={traits} entry={entry} />
                              ))}
                            </>
                          )}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  <Table.Tr>
                    {playerData.map((player) => {
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
                          <Text size="xs" fw={700}>
                            {t("ui.player-overmasteries")}
                          </Text>
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
                    expandedTiers={expandedMasterTraitTiers}
                    onToggleTier={toggleMasterTraitTier}
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

type SkillboardTier = {
  key: number | "ex";
  nodes: { text: string; unlocked: boolean; warn: boolean }[];
};

/// The character's full master-trait board grouped by tier (Chaos 1-3, then
/// EX) with the player's unlocked nodes flagged, each tier sorted unlocked
/// first, then unselected DMG Cap warnings, then alphabetically within each
/// group. Placement comes from the
/// game's skillboard_layout table (skillboard-layout.json) — the node id does
/// not encode the tier. Empty when the player has no skillboard data at all
/// (older logs, companions) so the cell falls back to a placeholder instead
/// of an all-unselected board.
function groupSkillboardNodes(player: PlayerData): { total: number; tiers: SkillboardTier[] } {
  const unlocked = player.skillboard ?? [];
  if (unlocked.length === 0) return { total: 0, tiers: [] };

  const unlockedIds = new Set(unlocked);
  const tiers = new Map<number | "ex", SkillboardTier["nodes"]>();
  let total = 0;
  const push = (tierKey: number | "ex", id: number, isUnlocked: boolean) => {
    if (isUnlocked) total += 1;
    let tier = tiers.get(tierKey);
    if (!tier) tiers.set(tierKey, (tier = []));
    const text = translateSkillboardNode(player.characterType, id);
    // Unselected DMG Cap nodes are almost always a build mistake — flag them
    // like the checklist's warning state.
    tier.push({ text, unlocked: isUnlocked, warn: !isUnlocked && text.includes("DMG Cap") });
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
      .map(([key, nodes]) => ({
        key,
        nodes: nodes.sort(
          (a, b) =>
            Number(b.unlocked) - Number(a.unlocked) || Number(b.warn) - Number(a.warn) || a.text.localeCompare(b.text)
        ),
      })),
  };
}

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
  expandedTiers,
  onToggleTier,
  onToggleAll,
}: {
  playerData: PlayerData[];
  expandedTiers: Set<number | "ex">;
  onToggleTier: (tierKey: number | "ex") => void;
  onToggleAll: (tierKeys: (number | "ex")[], expand: boolean) => void;
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
  const allExpanded = tierKeys.length > 0 && tierKeys.every((tierKey) => expandedTiers.has(tierKey));

  const rows: JSX.Element[] = [];
  for (const tierKey of tierKeys) {
    const perPlayerTier = grouped.map((skillboard) => skillboard.tiers.find((tier) => tier.key === tierKey));
    const expanded = expandedTiers.has(tierKey);

    rows.push(
      <Table.Tr key={`tier-${tierKey}`} style={UNSTRIPED}>
        {perPlayerTier.map((tier, playerIndex) => (
          <Table.Td key={playerData[playerIndex].actorIndex} style={{ verticalAlign: "top" }}>
            {tier && (
              <UnstyledButton onClick={() => onToggleTier(tierKey)}>
                <Text size="xs" fw={600} c="dimmed" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {expanded ? <Minus size="0.7rem" weight="bold" /> : <Plus size="0.7rem" weight="bold" />}
                  {tierKey === "ex" ? t("ui.master-traits.ex") : t("ui.master-traits.tier", { tier: tierKey })} (
                  {tier.nodes.filter((node) => node.unlocked).length})
                </Text>
              </UnstyledButton>
            )}
          </Table.Td>
        ))}
      </Table.Tr>
    );

    if (!expanded) continue;

    const maxNodes = Math.max(...perPlayerTier.map((tier) => tier?.nodes.length ?? 0));
    for (let nodeIndex = 0; nodeIndex < maxNodes; nodeIndex++) {
      rows.push(
        <Table.Tr key={`tier-${tierKey}-node-${nodeIndex}`} style={UNSTRIPED}>
          {perPlayerTier.map((tier, playerIndex) => {
            const node = tier?.nodes[nodeIndex];

            return (
              <Table.Td key={playerData[playerIndex].actorIndex} style={{ verticalAlign: "top" }}>
                <Placeholder empty={!node}>
                  {node && (
                    <Text
                      size="xs"
                      fw={300}
                      c={node.unlocked ? "teal" : node.warn ? "orange" : undefined}
                      style={{ display: "flex", alignItems: "center", gap: 4 }}
                    >
                      {node.warn ? (
                        <Warning size="0.7rem" weight="bold" style={{ flexShrink: 0 }} />
                      ) : (
                        // Kept invisible when locked so the text stays aligned.
                        <Check size="0.7rem" weight="bold" style={{ opacity: node.unlocked ? 1 : 0, flexShrink: 0 }} />
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

  return (
    <>
      <Table.Tr style={UNSTRIPED}>
        {playerData.map((player, playerIndex) => {
          const label =
            t("ui.player-master-traits") + (grouped[playerIndex].total > 0 ? ` (${grouped[playerIndex].total})` : "");

          return (
            <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
              {anyTraits ? (
                <UnstyledButton onClick={() => onToggleAll(tierKeys, !allExpanded)}>
                  <Text size="xs" fw={700} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {allExpanded ? <Minus size="0.7rem" weight="bold" /> : <Plus size="0.7rem" weight="bold" />}
                    {label}
                  </Text>
                </UnstyledButton>
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

function Placeholder({ empty, children }: { empty: boolean; children?: React.ReactNode }) {
  return empty ? (
    <Text size="xs" fw={300}>
      ---
    </Text>
  ) : (
    children
  );
}
