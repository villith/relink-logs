import { LegalityPlayerName } from "@/components/LegalityMark";
import { FilterState } from "@/stores/useLogIndexStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { Log, LogSortType, SortDirection, StoredLegalityFinding } from "@/types";
import {
  epochToLocalTime,
  hasQuestElapsedTime,
  millisecondsToElapsedFormat,
  translateEnemyType,
  translateEnemyTypeId,
  translateQuestId,
} from "@/utils";
import {
  Box,
  Button,
  Center,
  Checkbox,
  Divider,
  Flex,
  Group,
  Pagination,
  Select,
  Space,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { CaretDown, CaretLeft, WarningCircle } from "@phosphor-icons/react";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import "./logsTable.css";
import { PartyMember, partyMembers } from "./partyMembers";
import {
  ChainSummary,
  chainColors,
  chainKey,
  chainLatestTime,
  groupRepeatChains,
  summarizeChain,
} from "./repeatChains";
import useIndex from "./useIndex";

export const IndexPage = () => {
  const { t } = useTranslation();
  const {
    searchResult,
    selectedLogIds,
    setSelectedLogIds,
    setSelectedTargetSpans,
    confirmDeleteSelected,
    handleSetPage,
    currentPage,
    toggleSort,
    setFilters,
    filters,
    toggleAdvancedFilters,
  } = useIndex();

  const { streamer_mode, show_display_names, show_flagged_builds } = useMeterSettingsStore(
    useShallow((state) => ({
      show_display_names: state.show_display_names,
      streamer_mode: state.streamer_mode,
      show_flagged_builds: state.show_flagged_builds,
    }))
  );

  // Repeat Quest chains start closed: a farming session is one entry in the
  // list until the user asks for its runs, and a page of open chains buries the
  // rest of the history under rows that all say the same thing. State tracks
  // what has been EXPANDED, so the default (nothing here) is collapsed and a
  // new page starts closed.
  const [expandedChains, setExpandedChains] = useState<number[]>([]);
  const toggleChain = (key: number) =>
    setExpandedChains((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]));

  const chainGroups = useMemo(() => groupRepeatChains(searchResult.logs), [searchResult.logs]);

  // Everything about a chain that does not depend on what is selected or open,
  // derived once per page. `runs` in particular: rebuilt inline it was a fresh
  // array on every render, which is what made the summary memos downstream miss
  // every time and recompute anyway.
  const chains = useMemo(() => {
    const colors = chainColors(chainGroups);
    return chainGroups.map((group) => {
      const runs = [group.leader, ...group.rest];
      const chained = group.rest.length > 0;

      return {
        key: chainKey(group.leader),
        leader: group.leader,
        runs,
        chained,
        color: colors.get(chainKey(group.leader)),
        // Only within a chain: a lone log is trivially its own best, and
        // marking every unchained row would make the accent mean nothing.
        summary: chained ? summarizeChain(runs) : null,
        latest: chained ? chainLatestTime(runs) : null,
      };
    });
  }, [chainGroups]);

  // Membership answered in one step per row rather than a scan of the selection
  // per row — with "select all on page" ticked, every chain was rescanning the
  // whole page for each of its runs.
  const selectedIds = useMemo(() => new Set(selectedLogIds), [selectedLogIds]);

  const rows = chains.flatMap(({ key, leader, runs, chained, color, summary, latest }) => {
    const expanded = expandedChains.includes(key);
    const visible = chained && !expanded ? [] : runs;

    // A summary standing for the whole chain, rather than promoting one run to
    // speak for the others: the runs below it are its detail, and the figures
    // here are about the set.
    const summaryRow =
      summary === null ? null : (
        <ChainSummaryRow
          key={`chain-${key}`}
          runs={runs}
          summary={summary}
          latest={latest}
          chainColor={color}
          expanded={expanded}
          onToggle={() => toggleChain(key)}
          selectedIds={selectedIds}
          selectedLogIds={selectedLogIds}
          setSelectedLogIds={setSelectedLogIds}
          questLabel={translateQuestId(leader.questId)}
          primaryTarget={translateEnemyType(leader.primaryTarget)}
          members={partyMembers(leader, {
            showDisplayNames: show_display_names,
            streamerMode: streamer_mode,
            t,
          })}
        />
      );

    const runRows = visible.map((log) => {
      const resetSelectedTargets = () => {
        setSelectedTargetSpans([]);
      };

      return (
        <LogEntry
          key={log.id}
          log={log}
          selectedLogIds={selectedLogIds}
          setSelectedLogIds={setSelectedLogIds}
          // A run inside a chain leaves these to the band above it, so they are
          // resolved only for the rows that draw them — `partyMembers` alone is
          // four i18next lookups a chained row would throw away.
          primaryTarget={chained ? "" : translateEnemyType(log.primaryTarget)}
          members={
            chained ? [] : partyMembers(log, { showDisplayNames: show_display_names, streamerMode: streamer_mode, t })
          }
          // Only when the user has asked to see verdicts at all. Withheld here
          // rather than at the mark, so the row cannot colour what it was never
          // given.
          findings={show_flagged_builds ? searchResult.legality?.[log.id] : undefined}
          resetSelectedTargets={resetSelectedTargets}
          chained={chained}
          chainColor={color}
          bestDuration={summary?.bestDurationId === log.id}
          bestQuestElapsed={summary?.bestQuestElapsedId === log.id}
        />
      );
    });

    return [summaryRow, ...runRows];
  });

  return (
    <Box>
      <Box py={"xs"}>
        <Group>
          <SelectableEnemy targetIds={searchResult.enemyIds} setFilters={setFilters} filters={filters} />
          <SelectableQuest questIds={searchResult.questIds} setFilters={setFilters} filters={filters} />
          <SelectableQuestCompletion setFilters={setFilters} filters={filters} />
          <Button size="s" variant="default" onClick={toggleAdvancedFilters}>
            {filters.showAdvancedFilters ? t("ui.logs.hide-advanced-filters") : t("ui.logs.show-advanced-filters")}
          </Button>
          {selectedLogIds.length > 0 && (
            <Button size="xs" variant="default" ml="auto" onClick={confirmDeleteSelected}>
              {t("ui.logs.delete-selected-btn", { count: selectedLogIds.length })}
            </Button>
          )}
        </Group>
      </Box>
      {/* The gap belongs to the filters, not to the pager below them: this Box
          still renders when the filters are hidden, so spacing the pager
          unconditionally would leave a hole under a row that is not there. */}
      <Box pb={filters.showAdvancedFilters ? "xs" : undefined}>
        <Group>
          {filters.showAdvancedFilters && (
            <SelectablePlayer playerIds={searchResult.playerIds} setFilters={setFilters} filters={filters} />
          )}
          {filters.showAdvancedFilters && (
            <SelectablePlayerType playerTypes={searchResult.playerTypes} setFilters={setFilters} filters={filters} />
          )}
          {/* Hidden with the verdicts themselves: filtering by something the
              user has asked not to see would narrow the list for a reason
              nothing on screen explains. */}
          {filters.showAdvancedFilters && show_flagged_builds && (
            <SelectableFlagged setFilters={setFilters} filters={filters} />
          )}
        </Group>
      </Box>
      {searchResult.logs.length === 0 && <BlankTable />}
      {searchResult.logs.length > 0 && (
        <Box>
          <Group justify="space-between">
            <Pagination total={searchResult.pageCount} value={currentPage} onChange={handleSetPage} />
            <Text size="sm" c="dimmed">
              {t("ui.logs.saved-count", { count: searchResult.logCount })}
            </Text>
          </Group>
          <Table striped highlightOnHover className="logs-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>
                  <Checkbox
                    aria-label="Select all (on page)"
                    checked={selectedLogIds.length == searchResult.logs.length}
                    onChange={(event) =>
                      setSelectedLogIds(event.currentTarget.checked ? searchResult.logs.map((log) => log.id) : [])
                    }
                  />
                </Table.Th>
                <Table.Th>
                  <SortableColumn
                    column="time"
                    sortType={filters.sortType}
                    sortDirection={filters.sortDirection}
                    onClick={() => toggleSort("time")}
                  >
                    {t("ui.logs.date")}
                  </SortableColumn>
                </Table.Th>
                <Table.Th>{t("ui.logs.quest-name")}</Table.Th>
                <Table.Th></Table.Th>
                <Table.Th>{t("ui.logs.primary-target")}</Table.Th>
                <Table.Th>
                  <SortableColumn
                    column="duration"
                    sortType={filters.sortType}
                    sortDirection={filters.sortDirection}
                    onClick={() => toggleSort("duration")}
                  >
                    {t("ui.logs.duration")}
                  </SortableColumn>
                </Table.Th>
                <Table.Th>
                  <SortableColumn
                    column="quest-elapsed-time"
                    sortType={filters.sortType}
                    sortDirection={filters.sortDirection}
                    onClick={() => toggleSort("quest-elapsed-time")}
                  >
                    {t("ui.logs.quest-elapsed-time")}
                  </SortableColumn>
                </Table.Th>
                <Table.Th>{t("ui.logs.name")}</Table.Th>
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        </Box>
      )}
    </Box>
  );
};

function SortableColumn({
  children,
  column,
  sortType,
  sortDirection,
  onClick,
}: {
  children: React.ReactNode;
  column: LogSortType;
  sortType: LogSortType;
  sortDirection: SortDirection;
  onClick: () => void;
}) {
  const isBeingSorted = sortType === column;

  return (
    <UnstyledButton onClick={onClick} variant="transparent">
      <Flex>
        {children}
        {isBeingSorted && (
          <Text size="xs" style={{ marginLeft: "0.25rem", marginTop: "0.20rem" }}>
            {sortDirection === "asc" ? "▲" : "▼"}
          </Text>
        )}
      </Flex>
    </UnstyledButton>
  );
}

/** The party, drawn one member at a time so a flagged build can colour exactly
 * the person it belongs to — and explain itself in the same words the log page
 * and the Cheat Audit use.
 *
 * Attribution is by party slot: `playerIndex` on a stored finding is the slot
 * the backend audited, and `partyMembers` carries the same number. Legacy
 * version-0 logs have no slots, so their members carry `null` and never match. */
function PartyNames({ members, findings }: { members: PartyMember[]; findings?: StoredLegalityFinding[] }) {
  return (
    <Text size="xs">
      {members.map((member, index) => (
        <Fragment key={index}>
          {index > 0 && ", "}
          <LegalityPlayerName
            findings={(findings ?? [])
              .filter((stored) => member.slot !== null && stored.playerIndex === member.slot)
              .map((stored) => stored.finding)}
          >
            {member.label}
          </LegalityPlayerName>
        </Fragment>
      ))}
    </Text>
  );
}

/** Hands a chain's colour to the stylesheet, which draws the spine and tints
 * the band from it. A custom property rather than an inline `boxShadow` so the
 * shape of the spine stays in CSS with the rest of the block's styling and only
 * the hue crosses over. */
const chainSpineStyle = (chainColor?: string): React.CSSProperties | undefined =>
  chainColor === undefined ? undefined : ({ "--logs-chain-color": chainColor } as React.CSSProperties);

/** The row a Repeat Quest chain is drawn as: what the set of runs beneath it
 * amounts to, not one of the runs standing in for the rest.
 *
 * It fills the same columns as a run so the table still reads down a column,
 * but only where a figure about the SET means something. The times become the
 * chain's best — the run it peaked at, which is also the run the list places
 * the block by — while the cleared mark and the View button stay empty: a
 * chain has no single outcome and no one run to open, and answering those
 * would be inventing one.
 */
function ChainSummaryRow({
  runs,
  summary,
  latest,
  chainColor,
  expanded,
  onToggle,
  selectedIds,
  selectedLogIds,
  setSelectedLogIds,
  questLabel,
  primaryTarget,
  members,
}: {
  runs: Log[];
  /** Computed by the page, which needs the same figures to mark the run that
   * set each best — one derivation, so the band and the accent cannot disagree
   * about which run that is. */
  summary: ChainSummary;
  latest: number | null;
  /** This chain's colour from the party palette, drawn down its spine. */
  chainColor?: string;
  expanded: boolean;
  onToggle: () => void;
  selectedIds: Set<number>;
  selectedLogIds: number[];
  setSelectedLogIds: (ids: number[]) => void;
  questLabel: string;
  primaryTarget: string;
  members: PartyMember[];
}): JSX.Element {
  const { t } = useTranslation();

  const ids = runs.map((run) => run.id);
  const selected = ids.filter((id) => selectedIds.has(id)).length;
  const allSelected = selected === ids.length;

  // One tick selects the whole session — a chain is usually kept or deleted as
  // a unit, and ticking five rows by hand to drop one farming run is busywork.
  const toggleSelection = () =>
    setSelectedLogIds(
      allSelected ? selectedLogIds.filter((id) => !ids.includes(id)) : [...new Set([...selectedLogIds, ...ids])]
    );

  // The chain's best, bare and in the column it belongs to — the band's own
  // styling says the figure is about the set, so a label repeating it on every
  // chain earned nothing. Closed, this is the only time the block shows, and a
  // real run's time is the one figure that can sit in a column beside the
  // standalone runs without misleading. Carried in the same accent the run that
  // set it wears, so opening the chain shows the two are the same number.
  const bestCell = (bestMs: number | null) => (
    <Text size="xs" className="logs-num logs-chain-best">
      {bestMs === null ? "-" : millisecondsToElapsedFormat(bestMs)}
    </Text>
  );

  return (
    // The whole band toggles: it is a heading for the rows under it, and a
    // 26px caret at the far end of a wide row is a small thing to ask for. The
    // caret stays as the labelled, keyboard-reachable control.
    <Table.Tr className="logs-chain-summary" style={chainSpineStyle(chainColor)} onClick={onToggle}>
      {/* Selecting a chain is not opening it, so the checkbox keeps its click
          to itself — without this, ticking it would also fold the runs away. */}
      <Table.Td onClick={(event: React.MouseEvent) => event.stopPropagation()}>
        <Checkbox
          aria-label={t("ui.logs.repeat-chain-select", { count: runs.length })}
          checked={allSelected}
          indeterminate={selected > 0 && !allSelected}
          onChange={toggleSelection}
        />
      </Table.Td>
      {/* The chain's most recent run, which is what the list is sorted by and
          what dates the chain wherever it sits. Not a range: showing one end of
          one read as a claim about the whole block. */}
      <Table.Td>
        <Text size="xs" className="logs-num">
          {latest === null ? "" : epochToLocalTime(latest)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{questLabel}</Text>
      </Table.Td>
      <Table.Td></Table.Td>
      <Table.Td>
        <Text size="xs">{primaryTarget}</Text>
      </Table.Td>
      <Table.Td>{bestCell(summary.bestDurationMs)}</Table.Td>
      <Table.Td>{bestCell(summary.bestQuestElapsedMs)}</Table.Td>
      <Table.Td>
        <PartyNames members={members} />
      </Table.Td>
      {/* The toggle sits in the actions column, among the View buttons of the
          runs it opens — it is the band's action, and the one control on this
          row that does something to the rows below. Centred rather than pushed
          to the edge: alone in its column it needs to read as a control, not as
          a stray glyph. Collapsed points LEFT, back toward the rows it folded
          away; on a right-hand disclosure a right-pointing caret aims at
          nothing. */}
      <Table.Td>
        <Group gap={6} wrap="nowrap" justify="center">
          <UnstyledButton
            // Stopped, or the row's own handler would toggle it straight back.
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-label={t("ui.logs.repeat-chain-toggle", { count: runs.length })}
            aria-expanded={expanded}
            className="logs-chain-toggle"
          >
            {expanded ? <CaretDown size={16} weight="bold" /> : <CaretLeft size={16} weight="bold" />}
          </UnstyledButton>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function LogEntry({
  log,
  selectedLogIds,
  setSelectedLogIds,
  primaryTarget,
  members,
  findings,
  resetSelectedTargets,
  chained,
  chainColor,
  bestDuration,
  bestQuestElapsed,
}: {
  log: Log;
  selectedLogIds: number[];
  setSelectedLogIds: (ids: number[]) => void;
  primaryTarget: string;
  members: PartyMember[];
  /** This log's stored verdicts, or nothing when the user has asked not to see
   * them — which reads the same as a log nobody was flagged in. */
  findings?: StoredLegalityFinding[];
  resetSelectedTargets: () => void;
  /** This chain's colour from the party palette, drawn down its spine. */
  chainColor?: string;
  /** True for a run inside a Repeat Quest chain. The band above it already
   * states everything that is constant across the chain — quest, enemy, party
   * — so this row leaves those cells to it and fills only what varies. */
  chained?: boolean;
  /** Marks this run as the chain's fastest by wall-clock and by in-game time.
   * The two can be different runs: a fight can end quickly and still sit in a
   * long post-clear wrap-up. */
  bestDuration?: boolean;
  bestQuestElapsed?: boolean;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <Table.Tr key={log.id} className={chained ? "logs-chain-run" : undefined} style={chainSpineStyle(chainColor)}>
      <Table.Td>
        <Checkbox
          aria-label="Select row"
          checked={selectedLogIds.includes(log.id)}
          onChange={(event) =>
            setSelectedLogIds(
              event.currentTarget.checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id)
            )
          }
        />
      </Table.Td>
      {/* The full stamp, chained or not: the band above states no date, so
          these rows are the only thing that dates the chain. The rail on this
          cell carries the nesting — indenting the text instead stepped one
          column out of its own header's track. */}
      <Table.Td>
        <Text size="xs" className="logs-num">
          {epochToLocalTime(log.time)}
        </Text>
      </Table.Td>
      {/* Quest, enemy and party are the band's to state. Blanking only some of
          what a chain holds constant left holes in different columns on
          different rows, which read as broken markup rather than as ditto. */}
      <Table.Td>{!chained && <Text size="xs">{translateQuestId(log.questId)}</Text>}</Table.Td>
      <Table.Td>{log.questId && log.questCompleted !== null && (log.questCompleted ? "✓" : "✕")}</Table.Td>
      <Table.Td>{!chained && <Text size="xs">{primaryTarget}</Text>}</Table.Td>
      {/* Weight as well as colour, so the chain's fastest still stands out for
          a reader who cannot separate the accent from the ✓ two cells over. */}
      <Table.Td>
        <Text size="xs" className={`logs-num${bestDuration ? " logs-chain-best" : ""}`}>
          {millisecondsToElapsedFormat(log.duration)}
        </Text>
      </Table.Td>
      {/* In-game time. A dash on logs recorded before the quest timer was read
          correctly, and on fights the game never reported one for — those
          stored a constant 1s, which would otherwise read as a real 00:01. */}
      <Table.Td>
        <Text size="xs" className={`logs-num${bestQuestElapsed ? " logs-chain-best" : ""}`}>
          {hasQuestElapsedTime(log.questElapsedTime) ? millisecondsToElapsedFormat(log.questElapsedTime * 1000) : "-"}
        </Text>
      </Table.Td>
      <Table.Td>{!chained && <PartyNames members={members} findings={findings} />}</Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap" justify="flex-end">
          {log.imported && (
            <Tooltip label={t("ui.logs.imported-tooltip")} multiline w={280}>
              <WarningCircle size={20} color="var(--mantine-color-yellow-6)" aria-label={t("ui.imported-badge")} />
            </Tooltip>
          )}
          <Button size="xs" variant="default" component={Link} to={`/logs/${log.id}`} onClick={resetSelectedTargets}>
            {t("ui.view-btn")}
          </Button>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function BlankTable() {
  const { t } = useTranslation();

  return (
    <Box>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody></Table.Tbody>
      </Table>
      <Space h="sm" />
      <Center>
        <Text>{t("ui.logs.saved-count", { count: 0 })}</Text>
      </Center>
      <Divider my="sm" />
      <Pagination total={1} disabled />
    </Box>
  );
}

function SelectableEnemy({
  targetIds,
  filters,
  setFilters,
}: {
  targetIds: number[];
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();
  const targetOptions = useMemo(
    () => targetIds.map((id) => ({ value: id.toString(), label: translateEnemyTypeId(id) })),
    [targetIds]
  );

  return (
    <Select
      data={targetOptions}
      value={filters.filterByEnemyId?.toString() ?? null}
      onChange={(value) => setFilters({ filterByEnemyId: value ? Number(value) : null })}
      placeholder={t("ui.select-enemy")}
      searchable
      clearable
    />
  );
}

function SelectableQuest({
  questIds,
  filters,
  setFilters,
}: {
  questIds: number[];
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();
  const questOptions = useMemo(
    () => questIds.map((id) => ({ value: id.toString(), label: translateQuestId(id) })),
    [questIds]
  );

  return (
    <Select
      data={questOptions}
      value={filters.filterByQuestId?.toString() ?? null}
      onChange={(value) => setFilters({ filterByQuestId: value ? Number(value) : null })}
      placeholder={t("ui.select-quest")}
      searchable
      clearable
    />
  );
}

function SelectableQuestCompletion({
  filters,
  setFilters,
}: {
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      data={[
        { value: "null", label: t("ui.logs.filter-all") },
        { value: "true", label: t("ui.logs.filter-completed") },
        { value: "false", label: t("ui.logs.filter-failed") },
      ]}
      onChange={(value) => setFilters({ questCompletedFilter: value === "null" ? null : value === "true" })}
      placeholder={t("ui.logs.filter-quest-completion")}
      value={filters.questCompletedFilter === null ? "null" : filters.questCompletedFilter ? "true" : "false"}
      onClear={() => setFilters({ questCompletedFilter: null })}
      searchable
      clearable
    />
  );
}

/** Quests narrowed to the ones somebody was flagged in. Two states, not three:
 * "who cheated" is a question people have; "show me only the clean runs" is
 * not, and an option nobody picks still costs everybody a read. */
function SelectableFlagged({
  filters,
  setFilters,
}: {
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();

  return (
    <Select
      data={[
        { value: "all", label: t("ui.logs.filter-all") },
        { value: "flagged", label: t("ui.logs.filter-flagged-only") },
      ]}
      onChange={(value) => setFilters({ flaggedOnly: value === "flagged" })}
      placeholder={t("ui.logs.filter-flagged")}
      value={filters.flaggedOnly ? "flagged" : "all"}
      onClear={() => setFilters({ flaggedOnly: false })}
      clearable
    />
  );
}

function SelectablePlayer({
  playerIds,
  filters,
  setFilters,
}: {
  playerIds: string[];
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();
  const targetOptions = useMemo(
    () => playerIds.map((id) => ({ value: id.toString(), label: id.toString() })),
    [playerIds]
  );

  return (
    <Select
      data={targetOptions}
      onChange={(value) => setFilters({ filterByPlayerId: value ? String(value) : null })}
      placeholder={t("ui.select-player")}
      value={filters.filterByPlayerId ?? null}
      searchable
      clearable
    />
  );
}

function SelectablePlayerType({
  playerTypes,
  filters,
  setFilters,
}: {
  playerTypes: string[];
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}) {
  const { t } = useTranslation();
  const targetOptions = useMemo(
    () => playerTypes.map((id) => ({ value: id.toString(), label: t(`characters:${id}`, `ui:characters.${id}`) })),
    [playerTypes]
  );

  return (
    <Select
      data={targetOptions}
      onChange={(value) => setFilters({ filterByPlayerCharacter: value ? String(value) : null })}
      value={filters.filterByPlayerCharacter ?? null}
      placeholder={t("ui.select-character")}
      searchable
      clearable
    />
  );
}
