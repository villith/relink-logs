import { backendErrorMessage } from "@/backendErrors";
import type { TransmarvelOutcome } from "@/types";
import { translateSigilId, translateTraitId, translateWrightstoneId } from "@/utils";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
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

import { orderedTraitOptions } from "./traitOptions";

import useTransmarvelSearcher, {
  familyCombos,
  POOL,
  sigilTrait2Options,
  slotTraitOptions,
  WrightstoneEntry,
} from "./useTransmarvelSearcher";

/** Pool traits are stored as lowercase hex strings (the wishlist's key
 * shape); rolled outcomes carry the trait as a number. */
const hex = (h: string) => parseInt(h, 16);

/** Mantine Select reserves null for "no selection", so the optional slots'
 * "match anything" choice needs its own sentinel value. */
const ANY = "any";

/** Most rolls one prediction may simulate (mirrored by the backend clamp in
 * predict_transmarvel). */
export const MAX_ROLLS = 50000;

/** Most result rows actually rendered — a full 50k-row table would hang the
 * webview. Matching and the first-hit line still cover every roll; the
 * truncation is reported under the table. */
export const MAX_SHOWN_ROWS = 1000;

/** Fixed widths shared by entry rows and their caption headers so the
 * captions line up as columns. */
const TRAIT2_W = 230;
const TYPE_W = 170;
const RARITY_W = 190;
const REMOVE_W = 28;
const HIT_W = 64;

/** One tier-0 combo per family, in pool order — drives the Type picker
 * (value = family, label = the stone's item name, shared by its tiers). */
const FAMILIES = POOL.wrightstones.combos.filter((c) => c.tier === 0);

/** A slot's level set, compact: "10–15" or "20". */
const levelRange = (levels: number[]) =>
  levels.length > 1 ? `${Math.min(...levels)}–${Math.max(...levels)}` : String(levels[0]);

/** Synthesis-style result cell: name line + dimmed trait/level line. */
const OutcomeCell = ({ outcome, hit }: { outcome: TransmarvelOutcome; hit: boolean }) => {
  const { t } = useTranslation();
  const name = outcome.type === "sigil" ? translateSigilId(outcome.sigilId) : translateWrightstoneId(outcome.item);
  const line =
    outcome.type === "sigil"
      ? [
          `${translateTraitId(outcome.trait1)} ${t("ui.level-short", { level: outcome.traitLevel })}`,
          outcome.trait2 !== null ? translateTraitId(outcome.trait2) : null,
        ]
          .filter(Boolean)
          .join(" / ")
      : outcome.traits
          .map(([trait, level]) => `${translateTraitId(trait)} ${t("ui.level-short", { level })}`)
          .join(" / ");
  return (
    <Stack gap={0}>
      <Text size="sm" fw={hit ? 700 : undefined}>
        {name}
      </Text>
      <Text size="xs" c="dimmed">
        {line}
      </Text>
    </Stack>
  );
};

/** Trailing cell of an entry row: the entry's own first-hit roll # once a
 * prediction exists, a dimmed dash when it never hits, blank otherwise. */
const HitCell = ({ hitIndex, hasPrediction }: { hitIndex: number | null; hasPrediction: boolean }) => {
  const { t } = useTranslation();
  return (
    <Box w={HIT_W} style={{ flexShrink: 0, textAlign: "center" }}>
      {hasPrediction &&
        (hitIndex !== null ? (
          <Badge color="green">{t("ui.toolbox.tm-entry-hit", { n: hitIndex + 1 })}</Badge>
        ) : (
          <Text size="sm" c="dimmed" title={t("ui.toolbox.tm-entry-no-hit")}>
            {/* eslint-disable-next-line i18next/no-literal-string -- bare glyph */}—
          </Text>
        ))}
    </Box>
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
    sigilHits,
    stoneHits,
    predict,
  } = useTransmarvelSearcher();

  const errorMessage = backendErrorMessage(t, "transmarvel", error);
  const busy = loading || predicting;
  const hasPrediction = prediction !== null && !prediction.unpredictable;
  const anyOption = { value: ANY, label: t("ui.toolbox.tm-any-option", "Any") };

  const sigilOptions = POOL.sigils
    .map((s) => ({ value: s.trait, label: translateSigilId(hex(s.sigilId)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  /** Trait selects share the synthesis picker's ordering: popular first,
   * then alphabetical behind a divider. */
  const traitSelectData = (traits: string[]) => [
    anyOption,
    ...orderedTraitOptions(traits, (trait) => translateTraitId(hex(trait))),
  ];

  /** True when another sigil entry already wishes this exact pair — edits
   * that would collide are ignored, because sanitize-on-read would silently
   * dedupe the row away otherwise. */
  const pairExists = (trait: string, trait2: string | null, except: number) =>
    sigils.some((e, i) => i !== except && e.trait === trait && e.trait2 === trait2);

  const changeSigil = (index: number, trait: string) => {
    const current = sigils[index].trait2;
    let trait2 = current !== null && sigilTrait2Options(trait).includes(current) ? current : null;
    if (pairExists(trait, trait2, index)) {
      if (trait2 === null) return;
      trait2 = null;
      if (pairExists(trait, null, index)) return;
    }
    setSigils(sigils.map((e, i) => (i === index ? { trait, trait2 } : e)));
  };

  const changeSigilTrait2 = (index: number, trait2: string | null) => {
    if (pairExists(sigils[index].trait, trait2, index)) return;
    setSigils(sigils.map((e, i) => (i === index ? { ...e, trait2 } : e)));
  };

  /** First sigil not already wishlisted with "any 2nd trait" — the add
   * button's default entry. */
  const addableSigil = POOL.sigils.find((s) => !sigils.some((e) => e.trait === s.trait && e.trait2 === null));

  /** Apply a patch to a stone entry, clearing any slot pick the patched
   * type/rarity no longer offers (rather than letting sanitize-on-read drop
   * the whole entry). */
  const changeStone = (index: number, patch: Partial<WrightstoneEntry>) => {
    const next = { ...stones[index], ...patch };
    if (next.slot2 !== null && !slotTraitOptions(next.family, next.minTier, 1).includes(next.slot2)) next.slot2 = null;
    if (next.slot3 !== null && !slotTraitOptions(next.family, next.minTier, 2).includes(next.slot3)) next.slot3 = null;
    setStones(stones.map((e, i) => (i === index ? next : e)));
  };

  // Rarity options are labeled by their level layout alone ("Lv 20/15/10");
  // the top tier shares tier 1's levels, so it's distinguished by naming its
  // fixed slot traits instead of quoting drop chances.
  const rarityOptions = (family: string) =>
    familyCombos(family).map((combo) => {
      const levels = combo.slots.map((s) => levelRange(s.levels)).join("/");
      const fixedSlots = combo.slots.slice(1).filter((s) => s.traits.length === 1);
      return {
        value: String(combo.tier),
        label:
          fixedSlots.length === 2
            ? t("ui.toolbox.tm-rarity-option-fixed", {
                levels,
                traits: fixedSlots.map((s) => translateTraitId(hex(s.traits[0]))).join(" / "),
              })
            : t("ui.toolbox.tm-rarity-option", { levels }),
      };
    });

  const filtered = matchesOnly ? results.filter((r) => r.hit) : results;
  const shown = filtered.slice(0, MAX_SHOWN_ROWS);

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.transmarvel-searcher", "Transmarvel Searcher")}</Title>
      {status && !status.gameRunning && <Alert color="yellow">{t("ui.toolbox.tm-game-not-running")}</Alert>}
      {(status?.rngUnpredictable || prediction?.unpredictable) && (
        <Alert color="orange">{t("ui.toolbox.tm-unpredictable")}</Alert>
      )}
      {error && <Alert color="red">{errorMessage}</Alert>}
      {stale && <Alert color="orange">{t("ui.toolbox.stale-results")}</Alert>}
      <Group align="flex-end" gap="sm">
        <TextInput
          label={t("ui.toolbox.tm-rolls", "Rolls to simulate")}
          inputMode="numeric"
          value={rolls === 0 ? "" : String(rolls)}
          onChange={(e) => {
            const digits = e.currentTarget.value.replace(/\D/g, "");
            setRolls(digits === "" ? 0 : Math.min(parseInt(digits, 10), MAX_ROLLS));
          }}
          disabled={busy}
          w={130}
        />
        <Button onClick={predict} loading={predicting} disabled={busy || rolls < 1}>
          {t("ui.toolbox.tm-predict", "Predict")}
        </Button>
      </Group>
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap="xs" style={{ flexShrink: 0 }} w={760}>
          <Group justify="space-between" align="center">
            <Title order={6}>{t("ui.toolbox.tm-sigil-wishlist", "Sigil wishlist")}</Title>
            <Button
              size="compact-sm"
              variant="light"
              disabled={busy || !addableSigil}
              onClick={() => addableSigil && setSigils([...sigils, { trait: addableSigil.trait, trait2: null }])}
            >
              {t("ui.toolbox.tm-add-sigil", "Add sigil")}
            </Button>
          </Group>
          {sigils.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("ui.toolbox.tm-no-sigils", "Add sigils you want to roll for.")}
            </Text>
          )}
          {sigils.length > 0 && (
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" c="dimmed" style={{ flexGrow: 1 }}>
                {t("ui.toolbox.tm-sigil", "Sigil")}
              </Text>
              <Text size="xs" c="dimmed" w={TRAIT2_W}>
                {t("ui.toolbox.tm-2nd-trait", "2nd trait")}
              </Text>
              <Box w={REMOVE_W} />
              <Box w={HIT_W} />
            </Group>
          )}
          {sigils.map((entry, index) => (
            <Group key={index} gap="xs" wrap="nowrap">
              <Select
                aria-label={t("ui.toolbox.tm-sigil", "Sigil")}
                searchable
                data={sigilOptions}
                value={entry.trait}
                onChange={(trait) => trait && changeSigil(index, trait)}
                allowDeselect={false}
                disabled={busy}
                style={{ flexGrow: 1 }}
              />
              <Select
                aria-label={t("ui.toolbox.tm-2nd-trait", "2nd trait")}
                searchable
                data={traitSelectData(sigilTrait2Options(entry.trait))}
                value={entry.trait2 ?? ANY}
                onChange={(value) => value && changeSigilTrait2(index, value === ANY ? null : value)}
                allowDeselect={false}
                disabled={busy}
                w={TRAIT2_W}
              />
              <ActionIcon
                variant="subtle"
                aria-label={t("ui.toolbox.tm-remove", "Remove")}
                onClick={() => setSigils(sigils.filter((_, i) => i !== index))}
              >
                <X />
              </ActionIcon>
              <HitCell hitIndex={sigilHits[index]} hasPrediction={hasPrediction} />
            </Group>
          ))}
          <Group justify="space-between" align="center" mt="sm">
            <Title order={6}>{t("ui.toolbox.tm-stone-wishlist", "Wrightstone wishlist")}</Title>
            <Button
              size="compact-sm"
              variant="light"
              disabled={busy}
              onClick={() =>
                setStones([...stones, { family: FAMILIES[0].family, minTier: 0, slot2: null, slot3: null }])
              }
            >
              {t("ui.toolbox.tm-add-stone", "Add wrightstone")}
            </Button>
          </Group>
          {stones.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("ui.toolbox.tm-no-stones", "Add wrightstones you want to roll for.")}
            </Text>
          )}
          {stones.length > 0 && (
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" c="dimmed" w={TYPE_W}>
                {t("ui.toolbox.tm-stone-type", "Type")}
              </Text>
              <Text size="xs" c="dimmed" w={RARITY_W}>
                {t("ui.toolbox.tm-min-rarity", "Min rarity")}
              </Text>
              <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                {t("ui.toolbox.tm-slot-2", "Slot 2")}
              </Text>
              <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                {t("ui.toolbox.tm-slot-3", "Slot 3")}
              </Text>
              <Box w={REMOVE_W} />
              <Box w={HIT_W} />
            </Group>
          )}
          {stones.map((entry, index) => (
            <Group key={index} gap="xs" wrap="nowrap">
              <Select
                aria-label={t("ui.toolbox.tm-stone-type", "Type")}
                data={FAMILIES.map((c) => ({ value: c.family, label: translateWrightstoneId(hex(c.item)) }))}
                value={entry.family}
                onChange={(family) => family && changeStone(index, { family })}
                allowDeselect={false}
                disabled={busy}
                w={TYPE_W}
              />
              <Select
                aria-label={t("ui.toolbox.tm-min-rarity", "Min rarity")}
                data={rarityOptions(entry.family)}
                value={String(entry.minTier)}
                onChange={(tier) => tier && changeStone(index, { minTier: parseInt(tier, 10) })}
                allowDeselect={false}
                disabled={busy}
                w={RARITY_W}
              />
              <Select
                aria-label={t("ui.toolbox.tm-slot-2", "Slot 2")}
                searchable
                data={traitSelectData(slotTraitOptions(entry.family, entry.minTier, 1))}
                value={entry.slot2 ?? ANY}
                onChange={(value) => value && changeStone(index, { slot2: value === ANY ? null : value })}
                allowDeselect={false}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <Select
                aria-label={t("ui.toolbox.tm-slot-3", "Slot 3")}
                searchable
                data={traitSelectData(slotTraitOptions(entry.family, entry.minTier, 2))}
                value={entry.slot3 ?? ANY}
                onChange={(value) => value && changeStone(index, { slot3: value === ANY ? null : value })}
                allowDeselect={false}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <ActionIcon
                variant="subtle"
                aria-label={t("ui.toolbox.tm-remove", "Remove")}
                onClick={() => setStones(stones.filter((_, i) => i !== index))}
              >
                <X />
              </ActionIcon>
              <HitCell hitIndex={stoneHits[index]} hasPrediction={hasPrediction} />
            </Group>
          ))}
        </Stack>
        {prediction && !prediction.unpredictable && (
          <ScrollArea.Autosize
            mah="calc(100vh - 150px)"
            type="auto"
            style={{ flexGrow: 1, minWidth: 0 }}
            offsetScrollbars
          >
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
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={70}>{t("ui.toolbox.tm-col-roll", "Roll #")}</Table.Th>
                    <Table.Th>{t("ui.toolbox.tm-col-result", "Result")}</Table.Th>
                    <Table.Th w={80}>{t("ui.toolbox.tm-col-match", "Match")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shown.map(({ roll, index, hit }) => (
                    <Table.Tr key={index}>
                      <Table.Td>#{index + 1}</Table.Td>
                      <Table.Td>
                        <OutcomeCell outcome={roll.outcome} hit={hit} />
                      </Table.Td>
                      <Table.Td>{hit && <Badge color="green">{t("ui.toolbox.tm-match-yes", "✓")}</Badge>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {filtered.length > shown.length && (
                <Text size="xs" c="dimmed">
                  {t("ui.toolbox.tm-truncated", { shown: shown.length, total: filtered.length })}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Group>
    </Stack>
  );
};

export default TransmarvelSearcher;
