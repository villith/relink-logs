import {
  Alert,
  Anchor,
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
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { CaretRight, MagnifyingGlass, Warning } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LegalityFlaggedPlayer, LegalitySweepProgress } from "@/types";
import { epochToLocalTime, translateCharacterType, translateQuestId } from "@/utils";
import { TONE_COLOR, Violation, violationLabel, violationTone } from "@/violations";

import { FindingDetail } from "@/components/FindingDetail";
import { AuditFilters, DEFAULT_FILTERS, applyFilters, auditRows, caseFor, playerKey } from "./auditRows";

/**
 * The page's height, so its three lists scroll inside it rather than growing
 * the window.
 *
 * A person flagged in a hundred fights made every one of them a page the reader
 * had to scroll past to reach the next person, and a database with hundreds of
 * flagged players did the same to the rail. Bounding the page to the viewport is
 * what lets the rail, the evidence and the fight list each own a scrollbar and
 * stay put relative to one another.
 *
 * Same expression the Toolbox's own nav rail uses, read from Mantine's variables
 * so the two cannot drift: the AppShell header, plus its padding above and
 * below. `box-sizing: border-box` (Mantine's reset) means this box's own padding
 * is inside the figure.
 */
const PAGE_HEIGHT = "calc(100vh - var(--app-shell-header-height, 50px) - var(--mantine-spacing-sm) * 2)";

/** A violation, named.
 *
 * Red for every cheat — the old red/yellow split graded HOW damning the same
 * accusation was, which a reader has to decode, and the claim itself does that
 * job better: `max 20` reads as impossible. Gold is not that split come back:
 * it marks the one violation that is not an accusation at all ("Blessed by
 * RNG"), and it keeps the colour beside every player it applies to, cheat or
 * not. */
const ViolationChip = ({ violation }: { violation: Violation }) => {
  const { t } = useTranslation();

  return (
    <Badge size="sm" variant="light" color={TONE_COLOR[violationTone(violation)]} style={{ textTransform: "none" }}>
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

  /**
   * The fight list is the case's table of contents, and this is where a click
   * on it lands: the fight the reader picked, and the entry it took them to.
   *
   * Both, not just one. The entry is what gets scrolled to and marked; the
   * fight is what gets marked in the contents — and the two are not the same
   * row, because several fights routinely share one entry.
   */
  const [jumped, setJumped] = useState<{ fight: number; entry: number } | null>(null);
  const entryRefs = useRef(new Map<number, HTMLDivElement | null>());

  const jumpToEntry = (fight: number, entry: number) => {
    setJumped({ fight, entry });
    // Optional-called: jsdom has no layout, so it implements no scrollIntoView.
    entryRefs.current.get(entry)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

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

  // A mark left on the previous person's contents would point at an entry the
  // new person's case does not have.
  useEffect(() => setJumped(null), [selected]);

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

  const fights = found?.fights ?? [];

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
    <Box p="sm" style={{ height: PAGE_HEIGHT, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Above everything, and outside the scrollers, because a reader who
          scrolls past a caveat about accusations has not read it. Only on the
          page that names people: the empty state has no finding to doubt. */}
      <Alert color="yellow" variant="light" icon={<Warning size={16} />} mb="xs" p="xs">
        <Text size="xs">{t("ui.legality.disclaimer", { report: t("ui.report-bug") })}</Text>
      </Alert>

      {sweepBar}

      {/* `align="stretch"` so all three columns are as tall as the page and can
          each scroll to their own bottom. */}
      <Flex gap="sm" align="stretch" style={{ flexGrow: 1, minHeight: 0 }}>
        <Box w={200} style={{ flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
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
            // The count and the search box stay put; only the names scroll. A
            // search you cannot reach without scrolling back up is no search.
            <Box style={{ flexGrow: 1, minHeight: 0, overflowY: "auto" }}>
              <Stack gap={0}>
                {rows.map((row) => (
                  <UnstyledButton
                    key={row.key}
                    onClick={() => setSelected(row.key)}
                    p={6}
                    style={{
                      // The selection bar takes the row's tone: a gold name
                      // picked out by a red bar would re-accuse the person the
                      // colour just cleared.
                      borderLeft: `2px solid ${
                        row.key === selected
                          ? `var(--mantine-color-${TONE_COLOR[row.tone ?? "cheat"]}-6)`
                          : "transparent"
                      }`,
                      backgroundColor: row.key === selected ? "var(--mantine-color-dark-6)" : undefined,
                      borderRadius: 2,
                    }}
                  >
                    {/* Gold in the rail too: a page titled "Cheat Audit" listing
                        a farmer beside the mods is the complaint that created
                        the tone in the first place. */}
                    {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name */}
                    <Text size="sm" fw={600} truncate c={row.tone === "lucky" ? TONE_COLOR.lucky : undefined}>
                      {row.displayName || t("ui:characters.ai")}
                    </Text>
                    {/* eslint-disable-next-line i18next/no-literal-string -- already-translated character name */}
                    <Text size="xs" c="dimmed" truncate>
                      {translateCharacterType(row.characterType)}
                    </Text>
                  </UnstyledButton>
                ))}
              </Stack>
            </Box>
          )}
        </Box>

        {/* `minWidth: 0` so a long gear line wraps inside the pane instead of
            widening the flex row and pushing the rail off screen. */}
        <Box style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {!player || !found ? (
            <Center py="xl">
              <Text size="sm" c="dimmed">
                {t("ui.legality.select-player")}
              </Text>
            </Center>
          ) : (
            <>
              {/* Who, and what of. Outside the scrollers, so the name the reader
                  is reading evidence about never scrolls away from it. */}
              <Box mb={4}>
                {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name */}
                <Text size="lg" fw={700} c={found.tone === "lucky" ? TONE_COLOR.lucky : undefined}>
                  {player.displayName || t("ui:characters.ai")}
                </Text>
                {/* eslint-disable-next-line i18next/no-literal-string -- already-translated character name */}
                <Text size="xs" c="dimmed">
                  {translateCharacterType(player.characterType)}
                </Text>
              </Box>

              <Group gap={4} mb="xs">
                {found.violations.map((violation) => (
                  <ViolationChip key={violation} violation={violation} />
                ))}
              </Group>

              {/* Evidence and sightings side by side rather than stacked. They
                  answer two different questions — WHAT is wrong with the build,
                  and WHERE you met it — and the fight list is the one that grows
                  without bound: a hundred sightings below the evidence pushed
                  the evidence off the screen entirely. */}
              <Flex gap="sm" align="stretch" style={{ flexGrow: 1, minHeight: 0 }}>
                {/* Keyed by person so both scrollers remount when the selection
                    changes: a shared node keeps its scrollTop, which landed the
                    reader halfway down the next person's evidence. */}
                <Box key={selected} style={{ flexGrow: 1, minWidth: 0, overflowY: "auto" }}>
                  <Stack gap="xs">
                    {builds.map((build, buildIndex) => (
                      <Box
                        key={build.logId}
                        id={`audit-entry-${build.logId}`}
                        ref={(node: HTMLDivElement | null) => entryRefs.current.set(build.logId, node)}
                        // The border is always there, transparent when unmarked,
                        // so arriving at an entry does not shift the text under
                        // the reader's eye by two pixels.
                        pl={8}
                        style={{
                          borderLeft: `2px solid ${
                            jumped?.entry === build.logId ? "var(--mantine-color-red-6)" : "transparent"
                          }`,
                        }}
                      >
                        {buildIndex > 0 && <Divider mb="xs" />}
                        {/* Always, even for a lone build. This used to be gated
                            on there being more than one build to tell apart, on
                            the reasoning that a single group's fight is implied —
                            but it is only implied to someone who already knows
                            the page reduces findings to builds. To everyone else
                            an accusation with no fight attached is an accusation
                            with no date on it. */}
                        {build.fight && (
                          // Left in the link colour rather than dimmed: this is
                          // the way out to the fight itself, and a grey line
                          // that happens to be clickable reads as a caption.
                          <Anchor
                            component={Link}
                            to={`/logs/${build.logId}?tab=equipment`}
                            state={{ backTo: "/logs/toolbox/audit" }}
                            display="block"
                            mb={4}
                          >
                            {/* The arrow says this LEAVES the page. Without it
                                the heading is indistinguishable from the quest
                                name in the contents beside it, which is a link
                                that only scrolls. */}
                            <Group gap={4} wrap="nowrap">
                              {/* eslint-disable-next-line i18next/no-literal-string -- already-translated quest name and a formatted date */}
                              <Text size="xs" truncate>
                                {`${translateQuestId(build.fight.questId ?? null)} · ${epochToLocalTime(build.fight.time)}`}
                              </Text>
                              <CaretRight size={10} weight="bold" style={{ flexShrink: 0 }} />
                            </Group>
                          </Anchor>
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
                </Box>

                {/* Capped at a share of the pane, not just a px width: the
                    evidence beside this is the column that gives way when the
                    window narrows, and a fixed 460px here let this list shove
                    it to zero width and sit over where it was. The 40% cap
                    means the evidence always keeps the larger share; the fixed
                    table layout below ellipsizes quest names to fit. */}
                <Box
                  w="min(460px, 40%)"
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    borderLeft: "1px solid var(--mantine-color-dark-4)",
                    paddingLeft: "var(--mantine-spacing-sm)",
                  }}
                >
                  {/* Its own scroller, which is what retired the "+N more" fold:
                      that existed only to stop a long list burying the evidence,
                      and a column that scrolls on its own cannot bury anything.
                      The header stays put over it, which is also what replaced
                      the "Seen in" caption — a column headed "Quest / Date" says
                      what it is without a sentence above it. */}
                  <Box key={selected} style={{ flexGrow: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                    {/* `tableLayout: fixed` is what keeps this column from
                        scrolling sideways: with auto layout a long quest name
                        widens the table past the column and the scroller — which
                        has overflow-y, so overflow-x resolves to auto too —
                        grows a horizontal bar. Fixed makes the widths below
                        binding, so a long name ellipsizes instead. */}
                    <Table
                      striped
                      highlightOnHover
                      stickyHeader
                      verticalSpacing={2}
                      horizontalSpacing="xs"
                      fz="xs"
                      style={{ tableLayout: "fixed", width: "100%" }}
                    >
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t("ui.logs.quest-name")}</Table.Th>
                          {/* Wide enough for a full `epochToLocalTime` stamp
                              ("7/31/2026, 12:28 PM") plus the cell padding. Too
                              narrow and the nowrap date overflows its cell,
                              which is what put a horizontal scrollbar under a
                              table whose own width was already 100%. */}
                          <Table.Th w={165}>{t("ui.logs.date")}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {fights.map((fight) => (
                          // The whole row is the target. A row that highlights
                          // under the cursor but only responds on one word of
                          // itself invites the miss — and the date half is
                          // dead space that has to do something.
                          <Table.Tr
                            key={fight.logId}
                            onClick={() => jumpToEntry(fight.logId, fight.entryLogId)}
                            bg={jumped?.fight === fight.logId ? "var(--mantine-color-dark-6)" : undefined}
                            style={{ cursor: "pointer" }}
                          >
                            <Table.Td style={{ overflow: "hidden" }}>
                              {/* Still a real button inside the row, and not
                                  only for the look of it: a clickable `<tr>` is
                                  unreachable by keyboard, so this stays as the
                                  row's tab stop. Clicking it bubbles to the row
                                  and jumps twice to the same place, which costs
                                  nothing.

                                  Either way the move is WITHIN the case — the
                                  entry is already on screen beside the list, and
                                  leaving the page to show something a scroll
                                  away was the wrong answer to "show me this
                                  fight". */}
                              <Anchor
                                component="button"
                                type="button"
                                onClick={() => jumpToEntry(fight.logId, fight.entryLogId)}
                                size="xs"
                                display="block"
                                ta="left"
                                title={translateQuestId(fight.questId ?? null)}
                                style={{ overflow: "hidden", width: "100%" }}
                              >
                                {/* eslint-disable-next-line i18next/no-literal-string -- already-translated quest name */}
                                <Text size="xs" truncate>
                                  {translateQuestId(fight.questId ?? null)}
                                </Text>
                              </Anchor>
                            </Table.Td>
                            {/* Text, not a link. NOTHING in the contents leaves
                                the page: a list where one column scrolls and
                                the next navigates makes the reader guess which
                                click costs them their place. The way out to a
                                log is the entry heading, which is where the
                                arrow is. */}
                            {/* eslint-disable-next-line i18next/no-literal-string -- a formatted date */}
                            <Table.Td c="dimmed" style={{ whiteSpace: "nowrap" }}>
                              {epochToLocalTime(fight.time)}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Box>
                </Box>
              </Flex>
            </>
          )}
        </Box>
      </Flex>
    </Box>
  );
};

export default CheatAuditPage;
