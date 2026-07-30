import { Accordion, Alert, Badge, Box, Button, Center, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LegalityFlaggedPlayer, LegalitySweepProgress } from "@/types";
import { epochToLocalTime, formatCharacterLabel } from "@/utils";

import { claimsFor } from "./auditClaims";

/** Everything wrong with one person, worst first. */
const PlayerPanel = ({ player }: { player: LegalityFlaggedPlayer }) => {
  const { t } = useTranslation();
  // Rebuilt on language change so the sentences follow the UI language.
  const { i18n } = useTranslation();
  const claims = useMemo(() => claimsFor(t, player), [t, player, i18n.language]);

  return (
    <Stack gap={6} pl="xs">
      {claims.map((claim) => (
        <Group key={claim.key} gap="xs" align="flex-start" wrap="nowrap">
          <Badge size="xs" variant="light" color={claim.impossible ? "red" : "yellow"} style={{ flexShrink: 0 }}>
            {t(claim.impossible ? "ui.legality.impossible" : "ui.legality.improbable")}
          </Badge>
          <Box style={{ flex: 1 }}>
            <Text size="xs">{claim.text}</Text>
            <Text size="xs" c="dimmed">
              {t("ui.legality.encounters", { count: claim.encounters })}
            </Text>
          </Box>
          <Button size="compact-xs" variant="default" component={Link} to={`/logs/${claim.latestLogId}`}>
            {t("ui.legality.open-log")}
          </Button>
        </Group>
      ))}
    </Stack>
  );
};

/**
 * Build Audit: everyone you have played with whose equipment the game's own
 * tables say it could not have produced.
 *
 * Reads STORED verdicts, so opening the page is a query rather than a re-audit
 * of every log. A rules change is picked up by the startup sweep, whose
 * progress this page reports rather than showing a stale list as if it were
 * final.
 */
const BuildAuditPage = () => {
  const { t } = useTranslation();
  const [players, setPlayers] = useState<LegalityFlaggedPlayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweep, setSweep] = useState<LegalitySweepProgress | null>(null);

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

  const sweeping = sweep !== null && sweep.done < sweep.total;

  if (error) {
    return (
      <Alert color="red" m="sm">
        {t("ui.legality.failed", { error })}
      </Alert>
    );
  }

  return (
    <Box p="sm">
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          {t("ui.legality.description")}
        </Text>

        {sweeping && (
          <Box>
            <Text size="xs" c="dimmed" mb={4}>
              {t("ui.legality.rescanning", { done: sweep.done, total: sweep.total })}
            </Text>
            <Progress value={(sweep.done / Math.max(sweep.total, 1)) * 100} size="xs" />
          </Box>
        )}

        {players === null && (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        )}

        {players !== null && players.length === 0 && (
          <Center py="xl">
            <Text c="dimmed">{t("ui.legality.no-findings")}</Text>
          </Center>
        )}

        {players !== null && players.length > 0 && (
          <Accordion variant="separated" multiple>
            {players.map((player) => (
              <Accordion.Item
                key={`${player.displayName}-${player.characterType}`}
                value={`${player.displayName}-${player.characterType}`}
              >
                <Accordion.Control>
                  <Group gap="xs" wrap="nowrap">
                    <Badge size="sm" variant="light" color={player.impossible ? "red" : "yellow"}>
                      {t(player.impossible ? "ui.legality.impossible" : "ui.legality.improbable")}
                    </Badge>
                    {/* eslint-disable-next-line i18next/no-literal-string -- player-entered name and character id, data not prose */}
                    <Text size="sm" fw={600}>
                      {formatCharacterLabel(player.characterType, player.displayName)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t("ui.legality.encounters", { count: player.encounters })}
                    </Text>
                    <Text size="xs" c="dimmed" ml="auto">
                      {t("ui.legality.last-seen", { date: epochToLocalTime(player.lastSeen) })}
                    </Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <PlayerPanel player={player} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Stack>
    </Box>
  );
};

export default BuildAuditPage;
