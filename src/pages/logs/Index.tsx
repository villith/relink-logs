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
import { CaretDown, CaretRight, WarningCircle } from "@phosphor-icons/react";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { PartyMember, partyMembers } from "./partyMembers";
import { chainKey, groupRepeatChains } from "./repeatChains";
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

  // Repeat Quest chains collapse under their first row in display order;
  // expansion is per chain, keyed by the chain parent's id.
  const [expandedChains, setExpandedChains] = useState<number[]>([]);
  const toggleChain = (key: number) =>
    setExpandedChains((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]));

  const chainGroups = useMemo(() => groupRepeatChains(searchResult.logs), [searchResult.logs]);

  const rows = chainGroups.flatMap((group) => {
    const key = chainKey(group.leader);
    const expanded = expandedChains.includes(key);
    const visible = expanded ? [group.leader, ...group.rest] : [group.leader];

    return visible.map((log, position) => {
      const primaryTarget = translateEnemyType(log.primaryTarget);
      const members = partyMembers(log, { showDisplayNames: show_display_names, streamerMode: streamer_mode, t });

      const resetSelectedTargets = () => {
        setSelectedTargetSpans([]);
      };

      return (
        <LogEntry
          key={log.id}
          log={log}
          selectedLogIds={selectedLogIds}
          setSelectedLogIds={setSelectedLogIds}
          primaryTarget={primaryTarget}
          members={members}
          // Only when the user has asked to see verdicts at all. Withheld here
          // rather than at the mark, so the row cannot colour what it was never
          // given.
          findings={show_flagged_builds ? searchResult.legality?.[log.id] : undefined}
          resetSelectedTargets={resetSelectedTargets}
          chain={
            position === 0 && group.rest.length > 0
              ? { count: group.rest.length + 1, expanded, onToggle: () => toggleChain(key) }
              : undefined
          }
          chained={position > 0}
        />
      );
    });
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
      <Box>
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
          <Table striped highlightOnHover>
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
          <Divider my="sm" />
          <Group justify="space-between">
            <Pagination total={searchResult.pageCount} value={currentPage} onChange={handleSetPage} />
            <Text size="sm" c="dimmed">
              {t("ui.logs.saved-count", { count: searchResult.logCount })}
            </Text>
          </Group>
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

function LogEntry({
  log,
  selectedLogIds,
  setSelectedLogIds,
  primaryTarget,
  members,
  findings,
  resetSelectedTargets,
  chain,
  chained,
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
  /** Present on the visible row of a collapsed/expanded Repeat Quest chain:
   * how many runs it stands for, and the expand/collapse toggle. */
  chain?: { count: number; expanded: boolean; onToggle: () => void };
  /** True on the later rows of an expanded chain — indented under the row
   * carrying the toggle. */
  chained?: boolean;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <Table.Tr key={log.id}>
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
      <Table.Td>
        <Group gap={6} wrap="nowrap" pl={chained ? "lg" : undefined}>
          {chain && (
            <Tooltip label={t("ui.logs.repeat-chain-tooltip", { count: chain.count })} multiline w={280}>
              <UnstyledButton
                onClick={chain.onToggle}
                aria-label={t("ui.logs.repeat-chain-tooltip", { count: chain.count })}
              >
                <Group gap={2} wrap="nowrap">
                  {chain.expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                  <Text size="xs" fw={700}>
                    {t("ui.logs.repeat-chain-count", { count: chain.count })}
                  </Text>
                </Group>
              </UnstyledButton>
            </Tooltip>
          )}
          <Text size="xs">{epochToLocalTime(log.time)}</Text>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{translateQuestId(log.questId)}</Text>
      </Table.Td>
      <Table.Td>{log.questId && log.questCompleted !== null && (log.questCompleted ? "✓" : "X")}</Table.Td>
      <Table.Td>
        <Text size="xs">{primaryTarget}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{millisecondsToElapsedFormat(log.duration)}</Text>
      </Table.Td>
      {/* In-game time. A dash on logs recorded before the quest timer was read
          correctly, and on fights the game never reported one for — those
          stored a constant 1s, which would otherwise read as a real 00:01. */}
      <Table.Td>
        <Text size="xs">
          {hasQuestElapsedTime(log.questElapsedTime) ? millisecondsToElapsedFormat(log.questElapsedTime * 1000) : "-"}
        </Text>
      </Table.Td>
      <Table.Td>
        <PartyNames members={members} findings={findings} />
      </Table.Td>
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
