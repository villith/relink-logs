import { backendErrorMessage } from "@/backendErrors";
import type { TransmarvelOutcome, TransmarvelRoll } from "@/types";
import { translateSigilId, translateTraitId, translateWrightstoneId } from "@/utils";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { orderedTraitOptions } from "./traitOptions";

import useTransmarvelSearcher, {
  EntryHits,
  familyCombos,
  NO_HITS,
  parseSigilPickerValue,
  POOL,
  SigilEntry,
  sigilPickerOptions,
  sigilPickerValue,
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
const TYPE_W = 170;
const RARITY_W = 132;
const REMOVE_W = 28;
/** Roll-number gutter inside an entry's results block. */
const ROLL_NO_W = 44;

/** One tier-0 combo per family, in pool order — drives the Type picker
 * (value = family, label = the stone's item name minus the redundant
 * "Wrightstone", e.g. "Dread"). */
const FAMILIES = POOL.wrightstones.combos.filter((c) => c.tier === 0);

/** What a new wrightstone row starts as: Fortification at 20/15/10 with
 * Supplementary DMG in slot 2 — the roll people actually hunt, rather than
 * the worst rarity of whichever family sorts first. Falls back to a bare
 * entry if a pool regeneration retires that family, rarity, or trait, since
 * sanitize-on-read would otherwise drop the row and Add would do nothing. */
const DEFAULT_STONE: WrightstoneEntry = (() => {
  const preferred: WrightstoneEntry = { family: "f372f096", minTier: 1, slot2: "57ab5b10", slot3: null };
  const offered =
    familyCombos(preferred.family).some((c) => c.tier === preferred.minTier) &&
    slotTraitOptions(preferred.family, preferred.minTier, 1).includes(preferred.slot2!);
  return offered ? preferred : { family: FAMILIES[0].family, minTier: 0, slot2: null, slot3: null };
})();

/** "Dread Wrightstone" -> "Dread"; non-English names pass through whole. */
const stoneTypeName = (item: string) =>
  translateWrightstoneId(hex(item))
    .replace(/\s*wrightstone\s*/i, " ")
    .trim();

/** A rolled outcome's traits, one line. Sigil traits share a single level so
 * none is shown; a stone's slots carry their own. */
const useOutcomeLine = () => {
  const { t } = useTranslation();
  return (outcome: TransmarvelOutcome) =>
    outcome.type === "sigil"
      ? [translateTraitId(outcome.trait1), outcome.trait2 !== null ? translateTraitId(outcome.trait2) : null]
          .filter(Boolean)
          .join(" / ")
      : outcome.traits
          .map(([trait, level]) => `${translateTraitId(trait)} ${t("ui.level-short", { level })}`)
          .join(" / ");
};

/** Synthesis-style result cell: name line + dimmed trait line. */
const OutcomeCell = ({ outcome, hit }: { outcome: TransmarvelOutcome; hit: boolean }) => {
  const outcomeLine = useOutcomeLine();
  const name = outcome.type === "sigil" ? translateSigilId(outcome.sigilId) : translateWrightstoneId(outcome.item);
  return (
    <Stack gap={0}>
      <Text size="sm" fw={hit ? 700 : undefined}>
        {name}
      </Text>
      <Text size="xs" c="dimmed">
        {outcomeLine(outcome)}
      </Text>
    </Stack>
  );
};

/** Card props for one wishlist entry: entries the prediction actually hits
 * are outlined in green, so a wishlist scans at a glance without every row
 * having to say whether it hit. */
const entryCardProps = (hasHits: boolean) => ({
  withBorder: true,
  p: "xs" as const,
  "data-hits": hasHits || undefined,
  style: hasHits ? { borderColor: "var(--mantine-color-green-outline)" } : undefined,
});

/** What one entry matches, listed under its own row: roll # + the traits that
 * roll produces (a wildcard "Any" entry can't show them any other way). The
 * left rule and tight top margin tie the block to the row above it. */
const EntryResults = ({ hits, rolls }: { hits: EntryHits; rolls: TransmarvelRoll[] }) => {
  const { t } = useTranslation();
  const outcomeLine = useOutcomeLine();
  return (
    <Stack gap={2} mt={4} ml="xs" pl="sm" style={{ borderLeft: "2px solid var(--mantine-color-default-border)" }}>
      {hits.indices.map((index) => (
        <Group key={index} gap="sm" wrap="nowrap">
          <Text size="xs" c="dimmed" w={ROLL_NO_W} ta="right" style={{ flexShrink: 0 }}>
            {t("ui.toolbox.tm-entry-hit", { n: index + 1 })}
          </Text>
          <Text size="xs">{outcomeLine(rolls[index].outcome)}</Text>
        </Group>
      ))}
      {hits.total > hits.indices.length && (
        <Text size="xs" c="dimmed" pl={ROLL_NO_W + 12}>
          {t("ui.toolbox.tm-entry-more", { count: hits.total - hits.indices.length })}
        </Text>
      )}
    </Stack>
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

  // Tabs are controlled so a tab switch re-renders this component and the
  // measuring effect below re-runs.
  const [tab, setTab] = useState<string | null>("sigils");

  /** Anchor the results scroll area to the viewport bottom by measuring its
   * actual top edge. A fixed calc() offset drifts whenever the content above
   * (alerts, controls, tab list) changes, letting the page overflow and grow
   * a root scrollbar. Runs after every render; the setState bails out when
   * the value hasn't changed, and the measurement is skipped while the
   * results tab is hidden (offsetParent is null under display:none). */
  const resultsRef = useRef<HTMLDivElement>(null);
  const [resultsMah, setResultsMah] = useState("calc(100vh - 290px)");
  useEffect(() => {
    const node = resultsRef.current;
    if (!node || node.offsetParent === null) return;
    setResultsMah(`calc(100vh - ${Math.ceil(node.getBoundingClientRect().top) + 16}px)`);
  });
  const anyOption = { value: ANY, label: t("ui.toolbox.tm-any-option", "Any") };

  /** Every rollable sigil by name, fixed-pair sigils included — built each
   * render so a language switch relabels (and re-sorts) it. */
  const sigilOptions = sigilPickerOptions((sigilId) => translateSigilId(hex(sigilId)));
  const sigilOptionValues = new Set(sigilOptions.map((o) => o.value));

  /** The option representing an entry: its pair sigil when the wished traits
   * are exactly one the game ships as its own item, else the plain sigil. */
  const sigilValue = ({ trait, trait2 }: SigilEntry) => {
    if (trait2 === null) return trait;
    const paired = sigilPickerValue(trait, trait2);
    return sigilOptionValues.has(paired) ? paired : trait;
  };

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

  const changeSigil = (index: number, value: string) => {
    const picked = parseSigilPickerValue(value);
    const trait = picked.trait;
    // A fixed-pair sigil pins its 2nd trait. A plain one keeps the current
    // pick when the new sigil can still roll it — except when that pick came
    // from a pair the user just chose to move off, since keeping it would
    // re-pin the row to the sigil they navigated away from.
    const entry = sigils[index];
    const current = sigilValue(entry) === entry.trait ? entry.trait2 : null;
    let trait2 = picked.trait2 ?? (current !== null && sigilTrait2Options(trait).includes(current) ? current : null);
    if (pairExists(trait, trait2, index)) {
      if (trait2 === null || picked.trait2 !== null) return;
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

  // Rarity options are labeled by the max level per slot ("20/15/10"). The
  // fully-fixed 0.1% tier shares tier 1's levels and is folded into it —
  // minTier semantics already include better tiers (sanitizeWishlists clamps
  // stored top-tier entries to match).
  const rarityOptions = (family: string) =>
    familyCombos(family)
      .filter((combo) => combo.tier <= 1)
      .map((combo) => ({
        value: String(combo.tier),
        label: combo.slots.map((s) => String(Math.max(...s.levels))).join("/"),
      }));

  const filtered = matchesOnly ? results.filter((r) => r.hit) : results;
  const shown = filtered.slice(0, MAX_SHOWN_ROWS);

  /** Each list's tab counts the entries the prediction hits, so the other
   * list still reports itself while you work in this one. */
  const matchedSigils = sigilHits.filter((h) => h.total > 0).length;
  const matchedStones = stoneHits.filter((h) => h.total > 0).length;

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.toolbox.transmarvel-wishlist", "Transmarvel Wishlist")}</Title>
      {status && !status.gameRunning && <Alert color="yellow">{t("ui.toolbox.tm-game-not-running")}</Alert>}
      {(status?.rngUnpredictable || prediction?.unpredictable) && (
        <Alert color="orange">{t("ui.toolbox.tm-unpredictable")}</Alert>
      )}
      {error && <Alert color="red">{errorMessage}</Alert>}
      {stale && <Alert color="orange">{t("ui.toolbox.stale-results")}</Alert>}
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Group align="flex-end" gap="sm" style={{ flexShrink: 0 }}>
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
        <Tabs value={tab} onChange={setTab} style={{ flexGrow: 1, minWidth: 0 }}>
          <Tabs.List>
            <Tabs.Tab value="sigils">
              {t("ui.toolbox.tm-tab-sigils", { hit: matchedSigils, total: sigils.length })}
            </Tabs.Tab>
            <Tabs.Tab value="stones">
              {t("ui.toolbox.tm-tab-stones", { hit: matchedStones, total: stones.length })}
            </Tabs.Tab>
            <Tabs.Tab value="results">{t("ui.toolbox.tm-tab-results", "Full Results")}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="sigils" pt="sm">
            <Stack gap="xs">
              <Group justify="flex-end">
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
              {sigils.map((entry, index) => {
                const hits = sigilHits[index] ?? NO_HITS;
                // A fixed-pair sigil ships both traits, so its 2nd is not a
                // choice — the picker shows it, locked.
                const pinned = sigilValue(entry) !== entry.trait;
                return (
                  <Paper key={index} {...entryCardProps(hits.total > 0)}>
                    <Group gap="xs" wrap="nowrap" mb={2}>
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        {t("ui.toolbox.tm-sigil", "Sigil")}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        {t("ui.toolbox.tm-2nd-trait", "2nd Trait")}
                      </Text>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={t("ui.toolbox.tm-remove", "Remove")}
                        onClick={() => setSigils(sigils.filter((_, i) => i !== index))}
                      >
                        <X />
                      </ActionIcon>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <Select
                        aria-label={t("ui.toolbox.tm-sigil", "Sigil")}
                        searchable
                        data={sigilOptions}
                        value={sigilValue(entry)}
                        onChange={(value) => value && changeSigil(index, value)}
                        allowDeselect={false}
                        disabled={busy}
                        style={{ flex: 1 }}
                      />
                      <Select
                        aria-label={t("ui.toolbox.tm-2nd-trait", "2nd Trait")}
                        searchable
                        data={traitSelectData(sigilTrait2Options(entry.trait))}
                        value={entry.trait2 ?? ANY}
                        onChange={(value) => value && changeSigilTrait2(index, value === ANY ? null : value)}
                        allowDeselect={false}
                        disabled={busy || pinned}
                        style={{ flex: 1 }}
                      />
                      {/* Keeps the selects clear of the card's remove button. */}
                      <Box w={REMOVE_W} style={{ flexShrink: 0 }} />
                    </Group>
                    {hits.total > 0 && prediction && <EntryResults hits={hits} rolls={prediction.rolls} />}
                  </Paper>
                );
              })}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="stones" pt="sm">
            <Stack gap="xs">
              <Group justify="flex-end">
                <Button
                  size="compact-sm"
                  variant="light"
                  disabled={busy}
                  onClick={() => setStones([...stones, DEFAULT_STONE])}
                >
                  {t("ui.toolbox.tm-add-stone", "Add wrightstone")}
                </Button>
              </Group>
              {stones.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t("ui.toolbox.tm-no-stones", "Add wrightstones you want to roll for.")}
                </Text>
              )}
              {stones.map((entry, index) => {
                const hits = stoneHits[index] ?? NO_HITS;
                return (
                  <Paper key={index} {...entryCardProps(hits.total > 0)}>
                    <Group gap="xs" wrap="nowrap" mb={2}>
                      <Text size="xs" c="dimmed" w={TYPE_W}>
                        {t("ui.toolbox.tm-stone-type", "Type")}
                      </Text>
                      <Text size="xs" c="dimmed" w={RARITY_W}>
                        {t("ui.toolbox.tm-min-rarity", "Lvls")}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        {t("ui.toolbox.tm-slot-2", "Trait 2")}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        {t("ui.toolbox.tm-slot-3", "Trait 3")}
                      </Text>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={t("ui.toolbox.tm-remove", "Remove")}
                        onClick={() => setStones(stones.filter((_, i) => i !== index))}
                      >
                        <X />
                      </ActionIcon>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <Select
                        aria-label={t("ui.toolbox.tm-stone-type", "Type")}
                        data={FAMILIES.map((c) => ({ value: c.family, label: stoneTypeName(c.item) }))}
                        value={entry.family}
                        onChange={(family) => family && changeStone(index, { family })}
                        allowDeselect={false}
                        disabled={busy}
                        w={TYPE_W}
                      />
                      <Select
                        aria-label={t("ui.toolbox.tm-min-rarity", "Lvls")}
                        data={rarityOptions(entry.family)}
                        value={String(entry.minTier)}
                        onChange={(tier) => tier && changeStone(index, { minTier: parseInt(tier, 10) })}
                        allowDeselect={false}
                        disabled={busy}
                        w={RARITY_W}
                      />
                      <Select
                        aria-label={t("ui.toolbox.tm-slot-2", "Trait 2")}
                        searchable
                        data={traitSelectData(slotTraitOptions(entry.family, entry.minTier, 1))}
                        value={entry.slot2 ?? ANY}
                        onChange={(value) => value && changeStone(index, { slot2: value === ANY ? null : value })}
                        allowDeselect={false}
                        disabled={busy}
                        style={{ flex: 1 }}
                      />
                      <Select
                        aria-label={t("ui.toolbox.tm-slot-3", "Trait 3")}
                        searchable
                        data={traitSelectData(slotTraitOptions(entry.family, entry.minTier, 2))}
                        value={entry.slot3 ?? ANY}
                        onChange={(value) => value && changeStone(index, { slot3: value === ANY ? null : value })}
                        allowDeselect={false}
                        disabled={busy}
                        style={{ flex: 1 }}
                      />
                      {/* Keeps the selects clear of the card's remove button. */}
                      <Box w={REMOVE_W} style={{ flexShrink: 0 }} />
                    </Group>
                    {hits.total > 0 && prediction && <EntryResults hits={hits} rolls={prediction.rolls} />}
                  </Paper>
                );
              })}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="results" pt="sm">
            {prediction && !prediction.unpredictable && (
              <Box ref={resultsRef}>
                <ScrollArea.Autosize mah={resultsMah} type="auto" offsetScrollbars>
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                      {t("ui.toolbox.tm-results-caveat")}
                    </Text>
                    {firstHit === null && (
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
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {shown.map(({ roll, index, hit }) => (
                          <Table.Tr key={index}>
                            <Table.Td fw={hit ? 700 : undefined}>#{index + 1}</Table.Td>
                            <Table.Td>
                              <OutcomeCell outcome={roll.outcome} hit={hit} />
                            </Table.Td>
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
              </Box>
            )}
          </Tabs.Panel>
        </Tabs>
      </Group>
    </Stack>
  );
};

export default TransmarvelSearcher;
