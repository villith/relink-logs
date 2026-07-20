import { humanizeNumbers, translateOvermasteryId } from "@/utils";
import { Alert, Button, Group, ScrollArea, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";
import { OvermasteryMastery } from "@/types";

import useOvermasteryPredictor, {
  emptySlots,
  rollMatches,
  rollMatchesKinds,
  slotOptions,
  sortRollForDisplay,
  wantedKindSet,
} from "./useOvermasteryPredictor";

/** Flat effects (ATK / HP) show bare values; everything else is a percent. */
const formatValue = (m: OvermasteryMastery): string => `+${Math.round(m.value * 10) / 10}${m.kind >= 2 ? "%" : ""}`;

type IndexedRoll = { roll: OvermasteryMastery[]; index: number };

/** Total MSP to reach a roll, k-shortened: 220000 -> "220k MSP". */
const formatMsp = (total: number): string => humanizeNumbers(total).join("") + " MSP";

/** Effect grid with a sticky header: one row per rolled effect, with the
 * roll number + total MSP cost spanning its effects; a heavier top border
 * groups each roll. */
const RollTable = ({ rolls, mspCost, wanted }: { rolls: IndexedRoll[]; mspCost: number; wanted: Set<number> }) => {
  const { t } = useTranslation();
  return (
    <Table withRowBorders={false} stickyHeader w="650px">
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={90}>{t("ui.toolbox.om-col-roll", "Roll #")}</Table.Th>
          <Table.Th w={400}>{t("ui.toolbox.om-col-overmastery", "Overmastery")}</Table.Th>
          <Table.Th w={80}>{t("ui.toolbox.om-col-value", "Value")}</Table.Th>
          <Table.Th w={80}>{t("ui.toolbox.om-col-lvl", "Lvl")}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody fz="xs">
        {rolls.map(({ roll, index }) =>
          roll.map((m, j) => (
            <Table.Tr
              key={`${index}-${j}`}
              style={j === 0 ? { borderTop: "1px solid var(--mantine-color-default-border)" } : undefined}
            >
              {j === 0 && (
                <Table.Td rowSpan={roll.length} style={{ verticalAlign: "top" }}>
                  #{index + 1}
                  <Text size="xs" c="dimmed">
                    {formatMsp((index + 1) * mspCost)}
                  </Text>
                </Table.Td>
              )}
              <Table.Td fw={wanted.has(m.kind) ? 700 : undefined}>{translateOvermasteryId(m.category)}</Table.Td>
              <Table.Td fw={wanted.has(m.kind) ? 700 : undefined}>{formatValue(m)}</Table.Td>
              <Table.Td fw={wanted.has(m.kind) ? 700 : undefined}>{m.level}</Table.Td>
            </Table.Tr>
          ))
        )}
      </Table.Tbody>
    </Table>
  );
};

/** Descending so the common "high level" goals are next to Any. */
const LEVEL_OPTIONS = Array.from({ length: 10 }, (_, i) => String(10 - i));

/** Sentinel select value for the "Any" wildcard (stored as null in the form). */
const ANY = "any";
const anyOption = (t: (key: string, fallback: string) => string) => ({
  value: ANY,
  label: t("ui.toolbox.om-any", "Any"),
});

const OvermasteryPredictor = () => {
  const { t } = useTranslation();
  const {
    form,
    setForm,
    selectCharacter,
    status,
    prediction,
    error,
    predicting,
    stale,
    loading,
    characterOptions,
    categoryOptions,
    filters,
    predict,
  } = useOvermasteryPredictor();

  const errorMessage = backendErrorMessage(t, "overmastery", error);

  // The form drives reads of live game memory: hold it while the initial
  // status fetch or a prediction is talking to the game. Deliberately NOT
  // gated on `status.gameRunning`: the status is a snapshot, and latching the
  // whole form on it would strand anyone who opens the tool before launching
  // the game. The hook re-reads the status when the window regains focus, so
  // the roster and the banner recover on their own.
  const busy = loading || predicting;

  const setSlot = (index: number, patch: Partial<(typeof form.wanted)[number]>) =>
    setForm({ ...form, wanted: form.wanted.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  const wanted = useMemo(() => wantedKindSet(filters), [filters]);
  // One pass: `rollMatches` is a backtracking search, so it runs once per
  // roll and only displayed rolls get sorted. Empty filters accept every
  // roll, so fullMatches = all and belowLevel = none.
  const { fullMatches, belowLevel } = useMemo(() => {
    const full: IndexedRoll[] = [];
    const below: IndexedRoll[] = [];
    (prediction?.rolls ?? []).forEach((roll, index) => {
      if (rollMatches(roll, filters)) full.push({ roll: sortRollForDisplay(roll, filters, wanted), index });
      else if (rollMatchesKinds(roll, filters)) below.push({ roll: sortRollForDisplay(roll, filters, wanted), index });
    });
    return { fullMatches: full, belowLevel: below };
  }, [prediction, filters, wanted]);

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.overmastery-predictor", "Overmastery Predictor")}</Title>
      {status && !status.gameRunning && <Alert color="yellow">{t("ui.toolbox.om-game-not-running")}</Alert>}
      {prediction?.unpredictable && <Alert color="orange">{t("ui.toolbox.om-unpredictable")}</Alert>}
      {error && <Alert color="red">{errorMessage}</Alert>}
      {stale && <Alert color="orange">{t("ui.toolbox.stale-results")}</Alert>}
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap="sm" style={{ flexShrink: 0 }}>
          <Select
            label={t("ui.toolbox.om-character", "Character")}
            placeholder={t("ui.toolbox.om-select-character", "Select a character...")}
            searchable
            data={characterOptions}
            value={form.character}
            onChange={selectCharacter}
            disabled={busy}
            w={330}
          />
          <Select
            label={t("ui.toolbox.om-size", "Overmastery Level")}
            data={[
              { value: "0", label: t("ui.toolbox.om-size-small", "Lvl 1 (700 MSP)") },
              { value: "1", label: t("ui.toolbox.om-size-medium", "Lvl 2 (1,000 MSP)") },
              { value: "2", label: t("ui.toolbox.om-size-large", "Lvl 3 (2,000 MSP)") },
            ]}
            value={form.tier}
            onChange={(value) => value && setForm({ ...form, tier: value, wanted: emptySlots() })}
            allowDeselect={false}
            disabled={busy}
            w={330}
          />
          {form.wanted.map((slot, i) => (
            <Group key={i} align="flex-end" gap="sm" wrap="nowrap">
              <Select
                label={t("ui.toolbox.om-wanted-slot", { n: i + 1 })}
                searchable
                data={[anyOption(t), ...slotOptions(categoryOptions, form.wanted, i)]}
                value={slot.kind ?? ANY}
                onChange={(value) => value && setSlot(i, { kind: value === ANY ? null : value })}
                allowDeselect={false}
                disabled={busy}
                w={330}
              />
              <Select
                label={t("ui.toolbox.om-min-level", "Min level")}
                data={[anyOption(t), ...LEVEL_OPTIONS]}
                value={slot.minLevel === null ? ANY : String(slot.minLevel)}
                onChange={(value) => value && setSlot(i, { minLevel: value === ANY ? null : parseInt(value, 10) })}
                allowDeselect={false}
                disabled={busy}
                w={90}
              />
            </Group>
          ))}
          <Group align="flex-end" gap="sm">
            <TextInput
              label={t("ui.toolbox.om-rolls", "Rolls to simulate")}
              inputMode="numeric"
              value={form.rolls === 0 ? "" : String(form.rolls)}
              onChange={(e) => {
                const digits = e.currentTarget.value.replace(/\D/g, "");
                setForm({ ...form, rolls: digits === "" ? 0 : Math.min(parseInt(digits, 10), 500) });
              }}
              disabled={busy}
              w={130}
            />
            <Button onClick={predict} loading={predicting} disabled={busy || !form.character || form.rolls < 1}>
              {t("ui.toolbox.om-predict", "Predict")}
            </Button>
          </Group>
        </Stack>
        {prediction && !prediction.unpredictable && (
          <ScrollArea.Autosize
            mah="calc(100vh - 150px)"
            type="auto"
            style={{ flexGrow: 1, minWidth: 0 }}
            offsetScrollbars
          >
            <Stack gap="xs">
              {filters.length > 0 && fullMatches.length === 0 && (
                <Text size="sm">{t("ui.toolbox.om-no-match", { rolls: prediction.rolls.length })}</Text>
              )}
              <Text size="xs" c="dimmed">
                {t("ui.toolbox.om-results-caveat")}
              </Text>
              {fullMatches.length > 0 && <RollTable rolls={fullMatches} mspCost={prediction.mspCost} wanted={wanted} />}
              {belowLevel.length > 0 && (
                <>
                  <Title order={6}>{t("ui.toolbox.om-below-level", "Matches below minimum level")}</Title>
                  <RollTable rolls={belowLevel} mspCost={prediction.mspCost} wanted={wanted} />
                </>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Group>
    </Stack>
  );
};

export default OvermasteryPredictor;
