import { translateSigilId, translateTraitId } from "@/utils";
import { Alert, Badge, Button, Checkbox, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { SynthesisMatch, SynthesisSigil } from "@/types";
import { SYNTHESIS_ERR } from "@/synthesisErrors";

import useSynthesisHelper from "./useSynthesisHelper";

const SigilCell = ({ sigil }: { sigil: SynthesisSigil }) => (
  <Stack gap={0}>
    <Text size="sm">{translateSigilId(sigil.sigilId)}</Text>
    <Text size="xs" c="dimmed">
      {translateTraitId(sigil.trait1)} Lv{sigil.trait1Level}
      {translateTraitId(sigil.trait2) && ` / ${translateTraitId(sigil.trait2)} Lv${sigil.trait2Level}`}
    </Text>
  </Stack>
);

const ResultCell = ({ match }: { match: SynthesisMatch }) => {
  const { t } = useTranslation();
  const { prediction, resultSigilId } = match;
  return (
    <Group gap="xs">
      <Stack gap={0}>
        {resultSigilId !== null && <Text size="sm">{translateSigilId(resultSigilId)}</Text>}
        <Text size="xs" c="dimmed">
          {translateTraitId(prediction.trait1)}
          {prediction.trait2 !== null && ` / ${translateTraitId(prediction.trait2)}`}
        </Text>
      </Stack>
      {prediction.lucky && <Badge color="yellow">{t("ui.toolbox.high-roll", "high roll")}</Badge>}
    </Group>
  );
};

const SynthesisHelper = () => {
  const { t } = useTranslation();
  const { form, setForm, status, response, error, searching, traitOptions, search } = useSynthesisHelper();
  const options = traitOptions();

  // Map structured backend error strings to friendly copy; show anything else verbatim.
  const errorMessage =
    error === SYNTHESIS_ERR.gameNotRunning
      ? t("ui.toolbox.game-not-running")
      : error === SYNTHESIS_ERR.invalidTrait
        ? t("ui.toolbox.invalid-trait")
        : error;

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.synthesis-helper", "Synthesis Helper")}</Title>
      {status && !status.gameRunning && (
        <Alert color="yellow">{t("ui.toolbox.game-not-running")}</Alert>
      )}
      {(status?.rngUnpredictable || response?.rngUnpredictable) && (
        <Alert color="orange">{t("ui.toolbox.rng-unpredictable")}</Alert>
      )}
      {error && <Alert color="red">{errorMessage}</Alert>}
      <Group align="flex-end" gap="sm">
        <Select
          label={t("ui.toolbox.trait-1", "Trait 1 (first slot)")}
          placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
          searchable
          clearable
          data={options}
          value={form.trait1}
          onChange={(value) => setForm({ ...form, trait1: value })}
          w={260}
        />
        <Select
          label={t("ui.toolbox.trait-2", "Trait 2 (second slot)")}
          placeholder={t("ui.toolbox.select-trait", "Select a trait...")}
          searchable
          clearable
          data={options}
          value={form.trait2}
          onChange={(value) => setForm({ ...form, trait2: value })}
          w={260}
        />
        <Checkbox
          label={t("ui.toolbox.any-order", "Match either slot order")}
          checked={form.anyOrder}
          onChange={(e) => setForm({ ...form, anyOrder: e.currentTarget.checked })}
        />
        <Checkbox
          label={t("ui.toolbox.require-lucky", "High roll only (higher-level result)")}
          checked={form.requireLucky}
          onChange={(e) => setForm({ ...form, requireLucky: e.currentTarget.checked })}
        />
        <Button onClick={search} loading={searching} disabled={!form.trait1}>
          {t("ui.toolbox.search", "Search")}
        </Button>
      </Group>
      {response && (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            {t("ui.toolbox.pairs-summary", {
              sigils: response.sigilCount,
              tested: response.pairsTested,
              matches: response.totalMatches,
            })}
          </Text>
          <Text size="xs" c="dimmed">
            {t("ui.toolbox.results-caveat")}
          </Text>
          {response.totalMatches === 0 && <Text>{t("ui.toolbox.no-results")}</Text>}
          {response.totalMatches > response.matches.length && (
            <Text size="xs" c="dimmed">
              {t("ui.toolbox.truncated", { shown: response.matches.length, total: response.totalMatches })}
            </Text>
          )}
          {response.matches.length > 0 && (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("ui.toolbox.col-sigil-a", "Sigil A")}</Table.Th>
                  <Table.Th>{t("ui.toolbox.col-sigil-b", "Sigil B")}</Table.Th>
                  <Table.Th>{t("ui.toolbox.col-result", "Result")}</Table.Th>
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
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Stack>
  );
};

export default SynthesisHelper;
