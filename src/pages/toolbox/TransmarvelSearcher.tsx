import pool from "@/assets/transmarvel-pool.json";
import { backendErrorMessage } from "@/backendErrors";
import type { TransmarvelOutcome } from "@/types";
import { translateSigilId, translateTraitId } from "@/utils";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import useTransmarvelSearcher, { comboSatisfies, TransmarvelPool, WrightstoneEntry } from "./useTransmarvelSearcher";

const POOL = pool as TransmarvelPool;

/** Pool traits are stored as lowercase hex strings (the wishlist's key
 * shape); rolled outcomes carry the trait as a number. */
const hex = (h: string) => parseInt(h, 16);

/** Human name for one rolled outcome. */
const OutcomeCell = ({ outcome, hit }: { outcome: TransmarvelOutcome; hit: boolean }) => {
  const { t } = useTranslation();
  if (outcome.type === "sigil") {
    return (
      <Text size="xs" fw={hit ? 700 : undefined}>
        {translateSigilId(outcome.sigilId)}
      </Text>
    );
  }
  return (
    <Text size="xs" fw={hit ? 700 : undefined}>
      {outcome.traits.map(([trait, level]) => `${translateTraitId(trait)} ${t("ui.level-short", { level })}`).join(" / ")}
    </Text>
  );
};

const TransmarvelSearcher = () => {
  const { t } = useTranslation();
  const {
    status,
    error,
    loading,
    prediction,
    predicting,
    stale,
    rolls,
    setRolls,
    matchesOnly,
    setMatchesOnly,
    sigils,
    setSigils,
    stones,
    setStones,
    results,
    firstHit,
    predict,
  } = useTransmarvelSearcher();

  const errorMessage = backendErrorMessage(t, "transmarvel", error);
  const busy = loading || predicting;

  // Sigil picker: pool traits not already wishlisted.
  const sigilOptions = POOL.sigils
    .filter((s) => !sigils.some((e) => e.trait === s.trait))
    .map((s) => ({ value: s.trait, label: translateTraitId(hex(s.trait)) }));

  // Wrightstone slot pickers, constrained to valid combinations given the
  // entry's other slots: offer trait T for slot i iff some combo satisfies
  // the entry with slot i set to T (levels at their minimum).
  const slotTraitOptions = (entry: WrightstoneEntry, slotIndex: number) => {
    const seen = new Set<string>();
    for (const combo of POOL.wrightstones.combos) {
      for (const trait of combo.slots.flatMap((s) => s.traits)) {
        if (seen.has(trait)) continue;
        const slots = entry.slots.map((s, i) => (i === slotIndex ? { trait, minLevel: POOL.wrightstones.levels[0] } : s));
        if (slots.length === slotIndex) slots.push({ trait, minLevel: POOL.wrightstones.levels[0] });
        const candidate: WrightstoneEntry = { slots };
        if (POOL.wrightstones.combos.some((c) => comboSatisfies(c, candidate))) seen.add(trait);
      }
    }
    return [...seen].map((trait) => ({ value: trait, label: translateTraitId(hex(trait)) }));
  };

  const setStone = (index: number, entry: WrightstoneEntry) => setStones(stones.map((s, i) => (i === index ? entry : s)));
  const shown = matchesOnly ? results.filter((r) => r.hit) : results;

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.transmarvel-searcher", "Transmarvel Searcher")}</Title>
      {status && !status.gameRunning && <Alert color="yellow">{t("ui.toolbox.tm-game-not-running")}</Alert>}
      {(status?.rngUnpredictable || prediction?.unpredictable) && (
        <Alert color="orange">{t("ui.toolbox.tm-unpredictable")}</Alert>
      )}
      {error && <Alert color="red">{errorMessage}</Alert>}
      {stale && <Alert color="orange">{t("ui.toolbox.stale-results")}</Alert>}
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap="sm" style={{ flexShrink: 0 }} w={430}>
          <Title order={6}>{t("ui.toolbox.tm-sigil-wishlist", "Sigil wishlist")}</Title>
          {sigils.map((entry) => (
            <Group key={entry.trait} gap="xs" wrap="nowrap">
              <Text size="sm" style={{ flexGrow: 1 }}>
                {translateTraitId(hex(entry.trait))}
              </Text>
              <ActionIcon
                variant="subtle"
                aria-label={t("ui.toolbox.tm-remove", "Remove")}
                onClick={() => setSigils(sigils.filter((e) => e.trait !== entry.trait))}
              >
                <X />
              </ActionIcon>
            </Group>
          ))}
          <Select
            placeholder={t("ui.toolbox.tm-add-sigil", "Add sigil...")}
            searchable
            data={sigilOptions}
            value={null}
            onChange={(trait) => trait && setSigils([...sigils, { trait }])}
            disabled={busy}
          />
          <Title order={6}>{t("ui.toolbox.tm-stone-wishlist", "Wrightstone wishlist")}</Title>
          {stones.map((entry, index) => (
            <Group key={index} align="flex-end" gap="xs" wrap="wrap">
              {entry.slots.map((slot, si) => (
                <Group key={si} gap="xs" align="flex-end" wrap="nowrap">
                  <Select
                    label={t("ui.toolbox.tm-stone-trait-slot", { n: si + 1 })}
                    searchable
                    data={slotTraitOptions(entry, si)}
                    value={slot.trait}
                    onChange={(trait) =>
                      trait && setStone(index, { slots: entry.slots.map((s, i) => (i === si ? { ...s, trait } : s)) })
                    }
                    allowDeselect={false}
                    disabled={busy}
                    w={200}
                  />
                  <Select
                    label={t("ui.toolbox.tm-min-level", "Min level")}
                    data={POOL.wrightstones.levels.map(String)}
                    value={String(slot.minLevel)}
                    onChange={(v) =>
                      v && setStone(index, { slots: entry.slots.map((s, i) => (i === si ? { ...s, minLevel: parseInt(v, 10) } : s)) })
                    }
                    allowDeselect={false}
                    disabled={busy}
                    w={90}
                  />
                </Group>
              ))}
              {entry.slots.length < 3 && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  disabled={busy}
                  onClick={() => {
                    const opts = slotTraitOptions(entry, entry.slots.length);
                    if (opts.length) {
                      setStone(index, { slots: [...entry.slots, { trait: opts[0].value, minLevel: POOL.wrightstones.levels[0] }] });
                    }
                  }}
                >
                  {t("ui.toolbox.tm-add-stone-slot", "Add trait")}
                </Button>
              )}
              <ActionIcon
                variant="subtle"
                aria-label={t("ui.toolbox.tm-remove", "Remove")}
                onClick={() => setStones(stones.filter((_, i) => i !== index))}
              >
                <X />
              </ActionIcon>
            </Group>
          ))}
          <Button
            variant="light"
            disabled={busy}
            onClick={() =>
              setStones([
                ...stones,
                { slots: [{ trait: POOL.wrightstones.combos[0].slots[0].traits[0], minLevel: POOL.wrightstones.levels[0] }] },
              ])
            }
          >
            {t("ui.toolbox.tm-add-stone", "Add wrightstone")}
          </Button>
          <Group align="flex-end" gap="sm">
            <TextInput
              label={t("ui.toolbox.tm-rolls", "Rolls to simulate")}
              inputMode="numeric"
              value={rolls === 0 ? "" : String(rolls)}
              onChange={(e) => {
                const digits = e.currentTarget.value.replace(/\D/g, "");
                setRolls(digits === "" ? 0 : Math.min(parseInt(digits, 10), 500));
              }}
              disabled={busy}
              w={130}
            />
            <Button onClick={predict} loading={predicting} disabled={busy || rolls < 1}>
              {t("ui.toolbox.tm-predict", "Predict")}
            </Button>
          </Group>
        </Stack>
        {prediction && !prediction.unpredictable && (
          <ScrollArea.Autosize mah="calc(100vh - 150px)" type="auto" style={{ flexGrow: 1, minWidth: 0 }} offsetScrollbars>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {t("ui.toolbox.tm-results-caveat")}
              </Text>
              {firstHit !== null ? (
                <Text size="sm">{t("ui.toolbox.tm-first-hit", { n: firstHit + 1 })}</Text>
              ) : (
                <Text size="sm">{t("ui.toolbox.tm-no-hits", { rolls: prediction.rolls.length })}</Text>
              )}
              <Checkbox
                label={t("ui.toolbox.tm-matches-only", "Show matches only")}
                checked={matchesOnly}
                onChange={(e) => setMatchesOnly(e.currentTarget.checked)}
              />
              <Table withRowBorders={false} stickyHeader w="600px">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={90}>{t("ui.toolbox.tm-col-roll", "Roll #")}</Table.Th>
                    <Table.Th>{t("ui.toolbox.tm-col-outcome", "Outcome")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody fz="xs">
                  {shown.map(({ roll, index, hit }) => (
                    <Table.Tr key={index}>
                      <Table.Td>#{index + 1}</Table.Td>
                      <Table.Td>
                        <OutcomeCell outcome={roll.outcome} hit={hit} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Group>
    </Stack>
  );
};

export default TransmarvelSearcher;
