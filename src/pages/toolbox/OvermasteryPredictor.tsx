import {
  formatBonusAmount,
  humanizeNumbers,
  overmasteryAmountFromKind,
  toHashString,
  translateOvermasteryId,
} from "@/utils";
import {
  Alert,
  Button,
  Group,
  MultiSelect,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";
import { useTabParam } from "@/hooks/useTabParam";
import { OvermasteryCharacterPrediction, OvermasteryMastery } from "@/types";

import { ANY, anyOption } from "./traitOptions";

import ToolPage from "./ToolPage";

import useOvermasteryPredictor, {
  emptySlots,
  IndexedRoll,
  MAX_ROLLS,
  slotOptions,
  splitRollMatches,
  wantedKindSet,
} from "./useOvermasteryPredictor";

/** The magnitude the game shows for a rolled effect: "+1000", "+20%", "+10". */
const formatValue = (m: OvermasteryMastery): string => formatBonusAmount(overmasteryAmountFromKind(m.kind, m.value));

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

/** One character's results, ready to render: their tab's label and whether
 * their stream ever hits the goal, plus the two tables behind it. */
type CharacterTab = {
  /** Character id hash as 8-hex — the tab value, and the picker's option value. */
  value: string;
  label: string;
  result: OvermasteryCharacterPrediction;
  fullMatches: IndexedRoll[];
  belowLevel: IndexedRoll[];
};

/** Whether this character's stream reaches the goal at all, at a glance —
 * the whole point of predicting several of them side by side. */
const MatchMark = ({ matched }: { matched: boolean }) => {
  const { t } = useTranslation();
  return matched ? (
    <CheckCircle weight="fill" color="var(--mantine-color-teal-5)" aria-label={t("ui.toolbox.om-tab-matches")} />
  ) : (
    <XCircle color="var(--mantine-color-dimmed)" aria-label={t("ui.toolbox.om-tab-no-match")} />
  );
};

/** The results for the character whose tab is open. */
const CharacterResults = ({ tab, wanted, filtered }: { tab: CharacterTab; wanted: Set<number>; filtered: boolean }) => {
  const { t } = useTranslation();
  const { result, fullMatches, belowLevel } = tab;
  // Per character, not a whole-tool banner: one character being unreadable
  // (or unseeded) leaves everyone else's results perfectly good.
  const errorMessage = backendErrorMessage(t, "overmastery", result.error);
  if (errorMessage) return <Alert color="red">{errorMessage}</Alert>;
  if (!result.prediction) return null;
  if (result.prediction.unpredictable) return <Alert color="orange">{t("ui.toolbox.om-unpredictable")}</Alert>;

  return (
    <ScrollArea.Autosize mah="calc(100vh - 210px)" type="auto" offsetScrollbars>
      <Stack gap="xs">
        {filtered && fullMatches.length === 0 && (
          <Text size="sm">{t("ui.toolbox.om-no-match", { rolls: result.prediction.rolls.length })}</Text>
        )}
        <Text size="xs" c="dimmed">
          {t("ui.toolbox.om-results-caveat")}
        </Text>
        {fullMatches.length > 0 && (
          <RollTable rolls={fullMatches} mspCost={result.prediction.mspCost} wanted={wanted} />
        )}
        {belowLevel.length > 0 && (
          <>
            <Title order={6}>{t("ui.toolbox.om-below-level", "Matches below minimum level")}</Title>
            <RollTable rolls={belowLevel} mspCost={result.prediction.mspCost} wanted={wanted} />
          </>
        )}
      </Stack>
    </ScrollArea.Autosize>
  );
};

const OvermasteryPredictor = () => {
  const { t } = useTranslation();
  const {
    form,
    setForm,
    selectCharacters,
    characters,
    status,
    results,
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

  const labels = useMemo(() => new Map(characterOptions.map((o) => [o.value, o.label])), [characterOptions]);

  /** One tab per character the last Predict covered, in the order it asked
   * for them. A character whose label the roster no longer offers still gets
   * a tab under their raw hash rather than silently losing their results. */
  const tabs = useMemo<CharacterTab[]>(
    () =>
      results.map((result) => {
        const value = toHashString(result.charId);
        const split = result.prediction
          ? splitRollMatches(result.prediction.rolls, filters, wanted)
          : { fullMatches: [], belowLevel: [] };
        return { value, label: labels.get(value) ?? value, result, ...split };
      }),
    [results, filters, wanted, labels]
  );

  // The open tab lives in the URL, so leaving the toolbox and coming back
  // returns to the character that was being read.
  const [tab, setTab] = useTabParam(
    tabs.map((c) => c.value),
    tabs[0]?.value ?? ""
  );

  return (
    <ToolPage
      title={t("ui.toolbox.overmastery-predictor", "Overmastery Predictor")}
      gameNotRunning={status && !status.gameRunning ? t("ui.toolbox.om-game-not-running") : null}
      unpredictable={null}
      error={error ? errorMessage : null}
      stale={stale}
    >
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap="sm" style={{ flexShrink: 0 }}>
          <MultiSelect
            label={t("ui.toolbox.om-characters", "Characters")}
            placeholder={t("ui.toolbox.om-select-characters", "Select characters...")}
            searchable
            clearable
            hidePickedOptions
            data={[{ value: ANY, label: t("ui.toolbox.om-any-character", "Any (whole roster)") }, ...characterOptions]}
            value={form.characters}
            onChange={selectCharacters}
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
                setForm({ ...form, rolls: digits === "" ? 0 : Math.min(parseInt(digits, 10), MAX_ROLLS) });
              }}
              disabled={busy}
              w={130}
            />
            <Button onClick={predict} loading={predicting} disabled={busy || characters.length === 0 || form.rolls < 1}>
              {t("ui.toolbox.om-predict", "Predict")}
            </Button>
          </Group>
        </Stack>
        {tabs.length > 0 && (
          // `keepMounted={false}`: a whole-roster prediction is up to 19
          // characters' worth of roll tables, and only one is ever looked at.
          <Tabs value={tab} onChange={setTab} keepMounted={false} style={{ flexGrow: 1, minWidth: 0 }}>
            <Tabs.List>
              {tabs.map((character) => (
                <Tabs.Tab
                  key={character.value}
                  value={character.value}
                  // Nothing is wanted, so there is no match to report — every
                  // roll trivially "matches" and a tick would say nothing.
                  rightSection={
                    filters.length > 0 ? <MatchMark matched={character.fullMatches.length > 0} /> : undefined
                  }
                >
                  {character.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {tabs.map((character) => (
              <Tabs.Panel key={character.value} value={character.value} pt="sm">
                <CharacterResults tab={character} wanted={wanted} filtered={filters.length > 0} />
              </Tabs.Panel>
            ))}
          </Tabs>
        )}
      </Group>
    </ToolPage>
  );
};

export default OvermasteryPredictor;
