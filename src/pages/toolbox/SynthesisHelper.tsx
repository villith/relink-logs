import { translateSigilId, translateTraitId } from "@/utils";
import { Badge, Button, Checkbox, Group, ScrollArea, Select, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";

import { SynthesisMatch, SynthesisSigil } from "@/types";
import ToolPage from "./ToolPage";

import useSynthesisHelper from "./useSynthesisHelper";

const SigilCell = ({ sigil }: { sigil: SynthesisSigil }) => {
  const { t } = useTranslation();

  return (
    <Stack gap={0}>
      <Text size="sm">{translateSigilId(sigil.sigilId)}</Text>
      <Text size="xs" c="dimmed">
        {translateTraitId(sigil.trait1)} {t("ui.level-short", { level: sigil.trait1Level })}
        {translateTraitId(sigil.trait2) &&
          ` / ${translateTraitId(sigil.trait2)} ${t("ui.level-short", { level: sigil.trait2Level })}`}
      </Text>
    </Stack>
  );
};

const ResultCell = ({ match }: { match: SynthesisMatch }) => {
  const { prediction, resultSigilId } = match;
  return (
    <Stack gap={0}>
      {resultSigilId !== null && <Text size="sm">{translateSigilId(resultSigilId)}</Text>}
      <Text size="xs" c="dimmed">
        {translateTraitId(prediction.trait1)}
        {prediction.trait2 !== null && ` / ${translateTraitId(prediction.trait2)}`}
      </Text>
    </Stack>
  );
};

/** The predicted result level: the lucky roll is 15, the normal one 11. */
const LevelCell = ({ lucky }: { lucky: boolean }) => {
  const { t } = useTranslation();
  return lucky ? (
    <Badge color="yellow">{t("ui.toolbox.lvl-15", "Lvl 15")}</Badge>
  ) : (
    <Badge color="gray">{t("ui.toolbox.lvl-11", "Lvl 11")}</Badge>
  );
};

const SynthesisHelper = () => {
  const { t } = useTranslation();
  const { form, setForm, status, response, error, searching, stale, seedLatched, loading, traitOptions, search } =
    useSynthesisHelper();

  // The form drives reads of live game memory: hold it while the initial
  // status fetch or a search is talking to the game. Deliberately NOT gated
  // on `status.gameRunning`: the status is a snapshot, and latching the whole
  // form on it would strand anyone who opens the tool before launching the
  // game. Search re-reads live state and reports `game-not-running` itself,
  // and the hook re-reads the status when the window regains focus.
  const busy = loading || searching;

  const errorMessage = backendErrorMessage(t, "synthesis", error);

  // The game copies its live RNG stream into the saved synthesis seed when the
  // Sigil Synthesis screen opens, so a list computed before that is predicting
  // from a seed the game is about to replace — the classic "first result was
  // wrong, the rest were right". Nag from the live state AND from the shown
  // results: the game can latch a moment after a search that already missed.
  // `seedLatched` is null when there is no game to read, where the
  // game-not-running banner is the actionable one.
  const notLatched = seedLatched !== null && (seedLatched === false || response?.seedLatched === false);

  // Searching unlatched can only produce a list that has to be found again, so
  // the button waits. Gated on the LIVE state alone: once the game has latched,
  // re-searching is precisely the fix for an unlatched result list.
  const unlatchedNow = seedLatched === false;

  return (
    <ToolPage
      title={t("ui.toolbox.synthesis-helper", "Synthesis Helper")}
      gameNotRunning={status && !status.gameRunning ? t("ui.toolbox.game-not-running") : null}
      unpredictable={status?.rngUnpredictable || response?.rngUnpredictable ? t("ui.toolbox.rng-unpredictable") : null}
      notice={
        notLatched
          ? t(
              "ui.toolbox.seed-not-latched",
              "Open the Sigil Synthesis screen in game before searching — it locks in the prediction seed as it opens, so a list found beforehand will not match your first synthesis."
            )
          : null
      }
      error={error ? errorMessage : null}
      stale={stale}
    >
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap="sm" style={{ flexShrink: 0 }}>
          <Select
            label={t("ui.toolbox.trait-1", "Trait 1 (first slot)")}
            placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
            searchable
            clearable
            data={traitOptions}
            value={form.trait1}
            onChange={(value) => setForm({ ...form, trait1: value })}
            disabled={busy}
            w={260}
          />
          <Select
            label={t("ui.toolbox.trait-2", "Trait 2 (second slot)")}
            placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
            searchable
            clearable
            data={traitOptions}
            value={form.trait2}
            onChange={(value) => setForm({ ...form, trait2: value })}
            disabled={busy}
            w={260}
          />
          <Checkbox
            label={t("ui.toolbox.require-lucky", "Lvl 15 only")}
            checked={form.requireLucky}
            onChange={(e) => setForm({ ...form, requireLucky: e.currentTarget.checked })}
            disabled={busy}
          />
          <Checkbox
            label={t("ui.toolbox.any-order", "Match either slot order")}
            checked={form.anyOrder}
            onChange={(e) => setForm({ ...form, anyOrder: e.currentTarget.checked })}
            disabled={busy}
          />
          <Group>
            <Button onClick={search} loading={searching} disabled={busy || !form.trait1 || unlatchedNow}>
              {t("ui.toolbox.search", "Search")}
            </Button>
          </Group>
        </Stack>
        {response && (
          <ScrollArea.Autosize
            mah="calc(100vh - 150px)"
            type="auto"
            style={{ flexGrow: 1, minWidth: 0 }}
            offsetScrollbars
          >
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                {t("ui.toolbox.pairs-summary", {
                  sigils: response.sigilCount,
                  tested: response.pairsTested,
                  matches: response.matches.length,
                })}
              </Text>
              <Text size="xs" c="dimmed">
                {t("ui.toolbox.results-caveat")}
              </Text>
              {response.matches.length === 0 && <Text>{t("ui.toolbox.no-results")}</Text>}
              {response.matches.length > 0 && (
                <Table striped highlightOnHover stickyHeader>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("ui.toolbox.col-sigil-a", "Sigil A")}</Table.Th>
                      <Table.Th>{t("ui.toolbox.col-sigil-b", "Sigil B")}</Table.Th>
                      <Table.Th>{t("ui.toolbox.col-result", "Result")}</Table.Th>
                      <Table.Th>{t("ui.toolbox.col-level", "Level")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {response.matches.map((match) => (
                      <Table.Tr key={`${match.sigilA.uid}-${match.sigilB.uid}`}>
                        <Table.Td>
                          <SigilCell sigil={match.sigilA} />
                        </Table.Td>
                        <Table.Td>
                          <SigilCell sigil={match.sigilB} />
                        </Table.Td>
                        <Table.Td>
                          <ResultCell match={match} />
                        </Table.Td>
                        <Table.Td>
                          <LevelCell lucky={match.prediction.lucky} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Group>
    </ToolPage>
  );
};

export default SynthesisHelper;
