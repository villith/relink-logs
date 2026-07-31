import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Flex,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LegalityFlaggedPlayer, LegalitySweepProgress } from "@/types";
import { epochToLocalTime, translateCharacterType, translateQuestId } from "@/utils";
import { Violation, violationLabel } from "@/violations";

import { FindingDetail } from "@/components/FindingDetail";
import { AuditFilters, DEFAULT_FILTERS, applyFilters, auditRows, caseFor, playerKey } from "./auditRows";

/** How many flagged fights the case lists before folding the rest away. Enough
 * to show a pattern, few enough that the evidence above stays on screen. */
const FIGHTS_SHOWN = 3;

/** A violation, named.
 *
 * One colour for all of them. There used to be two — red for proof, yellow for
 * long odds — but "Impossible" and "Improbable" are adjectives a reader has to
 * decode, and the claim itself does that job better: `max 20` reads as
 * impossible, `1 in 950 rolls` reads as luck. */
const ViolationChip = ({ violation }: { violation: Violation }) => {
  const { t } = useTranslation();

  return (
    <Badge size="sm" variant="light" color="red" style={{ textTransform: "none" }}>
      {violationLabel(t, violation)}
    </Badge>
  );
};

/**
 * Cheat Audit: everyone you have played with whose equipment the game's own
 * tables say it could not have produced.
 *
 * Master–detail, because the question is "who cheats, and what did they do?"
 * and the answer is short: the census over a whole database returns a handful
 * of people. The rail is the whole list; the pane is one person's whole case.
 *
 * The tree this replaced made a reader open a person, then a fight, then read
 * gear. The case deduplicates a person's findings into what is actually
 * distinct about their build, and every finding carries the gear it is about,
 * so the whole page is ONE query: no encounter is opened, ever.
 *
 * Reads STORED verdicts, so opening the page is a query rather than a re-audit
 * of every log. A rules change is picked up by the startup sweep, whose
 * progress this page reports rather than showing a stale list as if it were
 * final.
 */
const CheatAuditPage = () => {
  const { t } = useTranslation();
  const [players, setPlayers] = useState<LegalityFlaggedPlayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweep, setSweep] = useState<LegalitySweepProgress | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [allFights, setAllFights] = useState(false);

  const [search] = useDebouncedValue(filters.search, 150);

  // Read through a ref so the sweep listener registers once: Tauri v1's
  // `listen` leaks a closure per call that `unlisten` never removes.
  const loadRef = useRef<() => void>(() => {});
  loadRef.current = () => {
    invoke<LegalityFlaggedPlayer[]>("fetch_legality_players")
      .then((result) => {
        setPlayers(result);
        setError(null);
      })
      .catch((e) => {
        setPlayers(null);
        setError(String(e));
      });
  };

  useEffect(() => {
    loadRef.current();

    const sweepListener = listen("legality-sweep-progress", (event: { payload: LegalitySweepProgress }) => {
      setSweep(event.payload);
      // The list is only final once the sweep is: reload when it finishes so
      // the page never settles on verdicts the old rules produced.
      if (event.payload.done >= event.payload.total) loadRef.current();
    });

    return () => {
      sweepListener.then((f) => f());
    };
  }, []);

  const kept = useMemo(() => (players ? applyFilters(players, { search }) : []), [players, search]);
  const rows = useMemo(() => auditRows(kept).sort((a, b) => b.lastSeen - a.lastSeen), [kept]);
  const byKey = useMemo(() => new Map(kept.map((p) => [playerKey(p), p])), [kept]);

  const player = selected === null ? undefined : byKey.get(selected);
  const found = useMemo(() => (player ? caseFor(player) : null), [player]);

  // Never a rail beside an empty pane: land on someone, and follow the list
  // when a search cuts the selected person out from under the reader.
  useEffect(() => {
    if (rows.length === 0) setSelected(null);
    else if (selected === null || !byKey.has(selected)) setSelected(rows[0].key);
  }, [rows, byKey, selected]);

  useEffect(() => setAllFights(false), [selected]);

  if (error) {
    return (
      <Alert color="red" m="sm">
        {t("ui.legality.failed", { error })}
      </Alert>
    );
  }

  if (players === null) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  const sweeping = sweep !== null && sweep.done < sweep.total;

  const sweepBar = sweeping && (
    <Box mb="xs">
      <Text size="xs" c="dimmed" mb={4}>
        {t("ui.legality.rescanning", { done: sweep.done, total: sweep.total })}
      </Text>
      <Progress value={(sweep.done / Math.max(sweep.total, 1)) * 100} size="xs" />
    </Box>
  );

  // Empty is the CORRECT result for almost everyone, so it says what was
  // checked. "Nothing flagged." alone made a working tool look broken.
  if (players.length === 0) {
    return (
      <Box p="sm">
        {sweepBar}
        <Center py="xl">
          <Stack gap={6} align="center" maw={420}>
            <Text fw={600}>{t("ui.legality.no-findings")}</Text>
            <Text size="xs" c="dimmed" ta="center">
              {t("ui.legality.no-findings-detail")}
            </Text>
          </Stack>
        </Center>
      </Box>
    );
  }

  const fights = found ? (allFights ? found.fights : found.fights.slice(0, FIGHTS_SHOWN)) : [];
  const hidden = found ? found.fights.length - fights.length : 0;

  /** The evidence, in groups of one build each. More than one group means the
   * person changed their gear between flagged fights, and each group is then
   * headed by the fight it was worn in — otherwise the two builds read as one
   * incoherent one wearing four sigils across two slots. */
  const builds = (found?.evidenceLogIds ?? []).map((logId) => ({
    logId,
    fight: found?.fights.find((fight) => fight.logId === logId),
    rows: (found?.evidence ?? []).filter((row) => row.logId === logId),
  }));

  return (
    <Box p="sm">
      {sweepBar}

      <Flex gap="sm" align="flex-start">
        <Box w={200} style={{ flexShrink: 0 }}>
          <Text size="xs" c="dimmed" mb={6}>
            {t("ui.legality.summary-players", { count: rows.length })}
          </Text>

          <TextInput
            size="xs"
            mb={6}
            placeholder={t("ui.legality.search-placeholder")}
            aria-label={t("ui.legality.search-placeholder")}
            leftSection={<MagnifyingGlass size={14} />}
            value={filters.search}
            onChange={(event) => setFilters({ search: event.currentTarget.value })}
          />

          {rows.length === 0 ? (
            <Stack gap={6} align="flex-start" p="xs">
              <Text size="xs" c="dimmed">
                {t("ui.legality.no-matches")}
              </Text>
              <Button size="compact-xs" variant="default" onClick={() => setFilters(DEFAULT_FILTERS)}>
                {t("ui.legality.clear-filters")}
              </Button>
            </Stack>
          ) : (
            <Stack gap={0}>
              {rows.map((row) => (
                <UnstyledButton
                  key={row.key}
                  onClick={() => setSelected(row.key)}
                  p={6}
                  style={{
                    borderLeft: `2px solid ${row.key === selected ? "var(--mantine-color-red-6)" : "transparent"}`,
                    backgroundColor: row.key === selected ? "var(--mantine-color-dark-6)" : undefined,
                    borderRadius: 2,
                  }}
                >
                  {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name */}
                  <Text size="sm" fw={600} truncate>
                    {row.displayName || t("ui:characters.ai")}
                  </Text>
                  {/* eslint-disable-next-line i18next/no-literal-string -- already-translated character name */}
                  <Text size="xs" c="dimmed" truncate>
                    {translateCharacterType(row.characterType)}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          )}
        </Box>

        {/* `minWidth: 0` so a long gear line wraps inside the pane instead of
            widening the flex row and pushing the rail off screen. */}
        <Box style={{ flexGrow: 1, minWidth: 0 }}>
          {!player || !found ? (
            <Center py="xl">
              <Text size="sm" c="dimmed">
                {t("ui.legality.select-player")}
              </Text>
            </Center>
          ) : (
            <Stack gap="xs">
              <Box>
                {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name */}
                <Text size="lg" fw={700}>
                  {player.displayName || t("ui:characters.ai")}
                </Text>
                {/* eslint-disable-next-line i18next/no-literal-string -- already-translated character name */}
                <Text size="xs" c="dimmed">
                  {translateCharacterType(player.characterType)}
                </Text>
              </Box>

              <Group gap={4}>
                {found.violations.map((violation) => (
                  <ViolationChip key={violation} violation={violation} />
                ))}
              </Group>

              <Stack gap="xs">
                {builds.map((build, buildIndex) => (
                  <Box key={build.logId}>
                    {buildIndex > 0 && <Divider mb="xs" />}
                    {/* Only when there is more than one build to tell apart. A
                        single build needs no heading saying which fight it came
                        from — every finding came from that one. */}
                    {builds.length > 1 && build.fight && (
                      <Text size="xs" c="dimmed" mb={4}>
                        {/* eslint-disable-next-line i18next/no-literal-string -- already-translated quest name and a formatted date */}
                        {`${translateQuestId(build.fight.questId ?? null)} · ${epochToLocalTime(build.fight.time)}`}
                      </Text>
                    )}
                    <Stack gap="xs">
                      {build.rows.map((row, index) => (
                        <Box key={index}>
                          {index > 0 && <Divider mb="xs" />}
                          <FindingDetail finding={row.finding} />
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                ))}
              </Stack>

              <Divider />

              <Box>
                <Text size="xs" c="dimmed" mb={2}>
                  {t("ui.legality.seen-in")}
                </Text>
                <Stack gap={2}>
                  {fights.map((fight) => (
                    <Group key={fight.logId} gap="xs" justify="space-between" wrap="nowrap">
                      <Text size="xs" truncate>
                        {/* eslint-disable-next-line i18next/no-literal-string -- already-translated quest name and a formatted date */}
                        {`${translateQuestId(fight.questId ?? null)} · ${epochToLocalTime(fight.time)}`}
                      </Text>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        component={Link}
                        to={`/logs/${fight.logId}?tab=equipment`}
                        rightSection={<CaretRight size={10} weight="bold" />}
                        style={{ flexShrink: 0 }}
                      >
                        {t("ui.legality.open-log")}
                      </Button>
                    </Group>
                  ))}
                  {hidden > 0 && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => setAllFights(true)}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {t("ui.legality.seen-more", { count: hidden })}
                    </Button>
                  )}
                </Stack>
              </Box>
            </Stack>
          )}
        </Box>
      </Flex>
    </Box>
  );
};

export default CheatAuditPage;
