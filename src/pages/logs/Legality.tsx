import { Badge, Box, Button, Center, Divider, Group, Stack, Table, Text, Title } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LegalityAuditEntry, LegalityAuditResult, LegalityFinding, LegalityValue } from "@/types";
import { epochToLocalTime, translateCharacterType } from "@/utils";

/**
 * DEV-ONLY DIAGNOSTIC — not a product feature.
 *
 * Runs `src-tauri/src/legality` over every stored log so its output can be
 * eyeballed against real data. Nothing is stored and nothing else in the app
 * reads it; delete this file, its route in App.tsx and `mod legality_audit` in
 * main.rs and the feature is gone.
 *
 * Expect noise: the summon rules fire on the large majority of
 * player-encounters as `improbable`. The `impossible` rows are the ones worth
 * reading, which is why everything here sorts by impossible count first.
 */

/** One player across all their encounters. Identity is the display name plus
 * character type — the same human on the same character, whatever slot they
 * were in — because a rule that fires for one person across many fights is the
 * signal, and a one-off is more likely a misread. */
type PlayerGroup = {
  key: string;
  displayName: string;
  characterName: string;
  characterLabel: string;
  impossible: number;
  total: number;
  /** Flat, severity-sorted, each finding carrying the encounter it came from. */
  rows: { entry: LegalityAuditEntry; finding: LegalityFinding }[];
};

/** Renders an untagged `legality::Value` verbatim. The rule, not the JSON,
 * says how to read the number, so this page deliberately does not interpret
 * it — an array stays an array and a missing value stays a dash. */
const formatValue = (value: LegalityValue): string => {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
};

/** `odds` is a probability, so the "1 in N" the user reads is 1/odds. */
const formatOdds = (odds: number | null): string | null => {
  if (odds === null || odds === undefined || odds <= 0) return null;
  return `1 in ${Math.round(1 / odds).toLocaleString()}`;
};

const groupByPlayer = (entries: LegalityAuditEntry[]): PlayerGroup[] => {
  const groups = new Map<string, PlayerGroup>();

  for (const entry of entries) {
    const characterLabel = translateCharacterType(entry.characterType);
    // An empty display name is an NPC/AI companion, which has no name of its
    // own — key those on the character so all of Vane's runs land together
    // instead of collapsing every unnamed companion into one group.
    const name = entry.displayName || entry.characterName || characterLabel;
    const key = `${name}::${characterLabel}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        displayName: name,
        characterName: entry.characterName,
        characterLabel,
        impossible: 0,
        total: 0,
        rows: [],
      };
      groups.set(key, group);
    }

    for (const finding of entry.findings) {
      group.rows.push({ entry, finding });
      group.total += 1;
      if (finding.severity === "impossible") group.impossible += 1;
    }
  }

  for (const group of groups.values()) {
    // Flat within a player, impossible first: the severities are different
    // claims (proof versus suspicion) and the proofs must not be buried under
    // the summon noise below them.
    group.rows.sort((a, b) => {
      const severity = Number(b.finding.severity === "impossible") - Number(a.finding.severity === "impossible");
      if (severity !== 0) return severity;
      return a.finding.rule.localeCompare(b.finding.rule);
    });
  }

  return [...groups.values()].sort((a, b) => b.impossible - a.impossible || b.total - a.total);
};

const FindingRow = ({ entry, finding }: { entry: LegalityAuditEntry; finding: LegalityFinding }) => {
  const { t } = useTranslation();
  const impossible = finding.severity === "impossible";
  const odds = formatOdds(finding.odds);

  return (
    <Table.Tr>
      <Table.Td>
        {/* eslint-disable-next-line i18next/no-literal-string -- rule id from the backend enum, data not prose */}
        <Text size="xs">{finding.rule}</Text>
      </Table.Td>
      <Table.Td>
        <Badge size="xs" color={impossible ? "red" : "yellow"} variant="light">
          {/* eslint-disable-next-line i18next/no-literal-string -- severity id from the backend enum, data not prose */}
          {finding.severity}
        </Badge>
      </Table.Td>
      <Table.Td>
        {/* eslint-disable-next-line i18next/no-literal-string -- subject id from the backend enum, data not prose */}
        <Text size="xs">
          {finding.subject.kind}
          {finding.subject.index !== undefined && finding.subject.index !== null ? ` #${finding.subject.index}` : ""}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{formatValue(finding.observed)}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{formatValue(finding.allowed)}</Text>
      </Table.Td>
      <Table.Td>
        {/* eslint-disable-next-line i18next/no-literal-string -- computed odds string, already numeric */}
        <Text size="xs">{odds ?? "—"}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed">
          {epochToLocalTime(entry.time)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Button size="compact-xs" variant="default" component={Link} to={`/logs/${entry.logId}`}>
          {t("ui.legality.open-log", { id: entry.logId })}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
};

/** Rows rendered per player before the list is truncated. Measured against the
 * real database: one player carried 2167 findings and the whole run 8848, which
 * is more DOM than the webview should be asked to build at once. The badges
 * above the table always show the FULL counts, so truncation never hides how
 * much fired — only how much is on screen. */
const ROW_CAP = 100;

const PlayerSection = ({ group }: { group: PlayerGroup }) => {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? group.rows : group.rows.slice(0, ROW_CAP);

  return (
    <Box mt="md">
      <Group gap="xs" align="baseline">
        {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name and character id, data not prose */}
        <Title order={5}>
          {group.displayName} ({group.characterLabel})
        </Title>
        <Badge size="sm" color={group.impossible > 0 ? "red" : "gray"} variant="light">
          {t("ui.legality.impossible-count", { count: group.impossible })}
        </Badge>
        <Badge size="sm" color="yellow" variant="light">
          {t("ui.legality.improbable-count", { count: group.total - group.impossible })}
        </Badge>
      </Group>
      <Table striped highlightOnHover mt="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("ui.legality.rule")}</Table.Th>
            <Table.Th>{t("ui.legality.severity")}</Table.Th>
            <Table.Th>{t("ui.legality.subject")}</Table.Th>
            <Table.Th>{t("ui.legality.observed")}</Table.Th>
            <Table.Th>{t("ui.legality.allowed")}</Table.Th>
            <Table.Th>{t("ui.legality.odds")}</Table.Th>
            <Table.Th>{t("ui.legality.encounter")}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(({ entry, finding }, index) => (
            <FindingRow key={`${entry.logId}-${entry.playerIndex}-${index}`} entry={entry} finding={finding} />
          ))}
        </Table.Tbody>
      </Table>
      {rows.length < group.rows.length && (
        <Group gap="xs" mt="xs">
          <Text size="xs" c="dimmed">
            {t("ui.legality.truncated", { shown: rows.length, total: group.rows.length })}
          </Text>
          <Button size="compact-xs" variant="default" onClick={() => setShowAll(true)}>
            {t("ui.legality.show-all")}
          </Button>
        </Group>
      )}
    </Box>
  );
};

export const LegalityPage = () => {
  const { t } = useTranslation();
  const [result, setResult] = useState<LegalityAuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Explicitly button-driven: this decompresses and deserializes every row in
  // the database, so it must never happen just because the page was opened.
  const runAudit = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await invoke<LegalityAuditResult>("audit_all_logs"));
    } catch (e) {
      setResult(null);
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const groups = result ? groupByPlayer(result.entries) : [];
  const impossible = groups.reduce((sum, group) => sum + group.impossible, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);

  return (
    <Box p="sm">
      <Stack gap="xs">
        <Group>
          <Button onClick={runAudit} loading={running}>
            {t("ui.legality.run")}
          </Button>
          <Text size="xs" c="dimmed">
            {t("ui.legality.description")}
          </Text>
        </Group>

        {error && (
          <Text size="sm" c="red">
            {t("ui.legality.failed", { error })}
          </Text>
        )}

        {result && (
          <Stack gap={2}>
            <Text size="sm">
              {t("ui.legality.scanned", {
                logs: result.logsScanned,
                players: groups.length,
                findings: total,
                impossible,
              })}
            </Text>
            {/* Never silent: a short list with an unreported skip count would
                read as a clean database. */}
            <Text size="sm" c={result.logsSkipped > 0 ? "red" : "dimmed"}>
              {t("ui.legality.skipped", { count: result.logsSkipped })}
            </Text>
          </Stack>
        )}
      </Stack>

      {result && groups.length === 0 && (
        <Center py="xl">
          <Text c="dimmed">{t("ui.legality.no-findings")}</Text>
        </Center>
      )}

      {groups.map((group) => (
        <Box key={group.key}>
          <Divider mt="md" />
          <PlayerSection group={group} />
        </Box>
      ))}
    </Box>
  );
};

export default LegalityPage;
