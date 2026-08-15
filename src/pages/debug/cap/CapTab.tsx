import { Box, Group, NumberInput, ScrollArea, Select, Stack, Text, UnstyledButton } from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { abilityLabelFor } from "@/pages/logs/view/analysis/abilityLabel";
import { explainCapHit } from "@/pages/logs/view/events/capExplain";
import { conditionsForHit } from "@/pages/logs/view/events/capFactors/conditions";
import { explainDamageHit } from "@/pages/logs/view/events/damageExplain";
import { getSkillName, millisecondsToPreciseElapsedFormat, translateCharacterType } from "@/utils";

import { CapDetailPanel } from "./CapDetailPanel";
import { HitPipeline } from "./HitPipeline";
import { hitLabel, type CapDebugHit } from "./capHits";
import { modeInferenceForHit } from "./modeInference";
import { useCapDebugLog, usePlayersByActor, useRecentLogs } from "./useCapDebugLog";

/** The hit list's width. Sized so a timestamp, a full ability key and a
 * seven-figure damage number sit on one line — at anything narrower the ability
 * column, which is the only one that says WHICH hit this is, is the one that
 * ellipsises. */
const LIST_WIDTH = 380;

/** A flex column whose children may scroll: `minHeight: 0` is what lets a
 * scroller inside shrink to the column's height instead of overflowing it. */
const FLEX_COLUMN = { display: "flex", flexDirection: "column", minHeight: 0 } as const;

/** One row in the per-character hit list. */
const HitRow = ({
  hit,
  name,
  selected,
  onSelect,
}: {
  hit: CapDebugHit;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) => (
  <UnstyledButton
    onClick={onSelect}
    data-cap-hit={hit.eventIndex}
    aria-pressed={selected}
    style={{
      display: "block",
      width: "100%",
      padding: "3px 8px",
      borderRadius: 3,
      background: selected ? "var(--mantine-color-dark-5)" : undefined,
      borderLeft: `2px solid ${selected ? "var(--mantine-color-yellow-4)" : "transparent"}`,
    }}
  >
    <Group gap="xs" wrap="nowrap">
      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {millisecondsToPreciseElapsedFormat(hit.timeMs)}
      </Text>
      <Text size="xs" truncate title={name} style={{ flex: 1, minWidth: 0 }}>
        {name}
      </Text>
      {/* A hit with no cap is the interesting one, so it is marked rather than
          left looking like an ordinary row with a blank column. */}
      <Text
        size="xs"
        c={hit.hit.damage_cap === null ? "orange.4" : "dimmed"}
        style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
      >
        {hit.hit.damage.toLocaleString()}
      </Text>
    </Group>
  </UnstyledButton>
);

/**
 * The damage-cap debugger: pick a log, pick a character, walk their hits, and
 * read the whole derivation for the selected one.
 *
 * Everything shown here is the SAME derivation the Amount hover card projects —
 * `explainCapHit` and the card both build on `capLadder`/`capSources`, so this
 * page cannot flatter the model into looking better than it is.
 */
export const CapTab = () => {
  const { t, i18n } = useTranslation();
  const recent = useRecentLogs();
  const [logId, setLogId] = useState<number | null>(null);
  const [actorIndex, setActorIndex] = useState<number | null>(null);
  const [eventIndex, setEventIndex] = useState<number | null>(null);

  const { hits, players, skillsByActor, capUp, amplifyStatusIds, chartWindows, truncated, loading, error } =
    useCapDebugLog(logId);
  const playersByActor = usePlayersByActor(players);

  // Named through the ANALYSIS view's own resolver, not a second spelling here:
  // `abilityLabelFor` already owns the group/raw split, the per-character skill
  // tables and the fallback chain that ends at "unknown skill" rather than at
  // `abilityKey`'s wire form ("Normal:200", which is what this list showed
  // before). The acting player is passed as `preferred` because action ids
  // collide across characters — 120 is Eustace's "Grade 1 Shot" AND Id's
  // "Combo Finisher (Dragonform)".
  const nameOf = useCallback(
    (hit: CapDebugHit) => {
      const owner = skillsByActor.get(hit.sourceIndex);
      return abilityLabelFor(hit.abilityKey, [...skillsByActor.values()], getSkillName, owner);
    },
    // i18n.language: every name this produces is translated.
    [skillsByActor, i18n.language]
  );

  // A new log invalidates both selections: an actor index means nothing across
  // logs, and an event index would land on an unrelated hit.
  useEffect(() => {
    setActorIndex(null);
    setEventIndex(null);
  }, [logId]);

  // Default to whoever the log actually has, so the list is never empty on
  // arrival just because nobody has clicked a chip yet.
  useEffect(() => {
    if (actorIndex === null && players.length > 0) setActorIndex(players[0].actorIndex);
  }, [players, actorIndex]);

  const shown = useMemo(
    () => (actorIndex === null ? [] : hits.filter((hit) => hit.sourceIndex === actorIndex)),
    [hits, actorIndex]
  );

  const selected = useMemo(() => shown.find((hit) => hit.eventIndex === eventIndex) ?? null, [shown, eventIndex]);

  // One source of truth for the loadout + conditions both panels explain —
  // computed once and fed to `explainCapHit` and `explainDamageHit` alike, so
  // the two columns can never drift into narrating the same hit against
  // different condition snapshots.
  const hitPanels = useMemo(() => {
    if (selected === null) return null;
    const player = playersByActor.get(selected.sourceIndex);
    // The attacker's own state at the moment of the hit, plus the stored stat
    // block the banded traits ramp across, plus the hit's own action id for
    // the move-scoped board nodes. A hit recorded before that capture existed
    // supplies neither, and the factors that need them say so rather than
    // reading as inactive.
    const conditions = conditionsForHit(selected.attacker, player?.playerStats ?? null, selected.actionId);
    // The fallback for a hit whose own snapshot cannot say: this target,
    // joined against the fight's Overdrive/Break windows at this hit's own
    // moment. `targetParentIndex`, not `targetIndex` — chart windows name an
    // enemy by its own actor index, not the folded instance pointer.
    const modeInference = modeInferenceForHit(chartWindows, selected.targetParentIndex, selected.timeMs);
    return {
      sections: explainCapHit({
        hit: selected.hit,
        capUp: capUp[String(selected.sourceIndex)],
        loadout: player,
        characterType: player?.characterType,
        conditions,
      }),
      damageSections: explainDamageHit({
        hit: selected.hit,
        loadout: player,
        conditions,
        amplifyStatusIds,
        modeInference,
      }),
    };
  }, [selected, playersByActor, capUp, amplifyStatusIds, chartWindows]);

  const logOptions = recent.map((log) => ({
    value: String(log.id),
    label: `#${log.id} ${log.name}`,
  }));

  return (
    // The page (Debug.tsx) is bounded to the viewport; this fills it, so the
    // hit list and the derivation columns take all the height the window has.
    <Stack gap="sm" h="100%" style={{ minHeight: 0 }}>
      <Group gap="sm" align="flex-end">
        <Select
          label={t("ui.debug.cap-log")}
          data={logOptions}
          value={logId === null ? null : String(logId)}
          onChange={(value) => setLogId(value === null ? null : Number(value))}
          searchable
          clearable
          w={320}
          nothingFoundMessage={t("ui.debug.cap-no-logs")}
        />
        {/* The picker only offers recent logs; a log referenced by id from a
            note or a bug report may be older than that. */}
        <NumberInput
          label={t("ui.debug.cap-log-id")}
          value={logId ?? ""}
          onChange={(value) => setLogId(value === "" ? null : Number(value))}
          min={1}
          hideControls
          w={110}
        />
        {loading && (
          <Text size="xs" c="dimmed" pb={8}>
            {t("ui.debug.cap-loading")}
          </Text>
        )}
        {error !== null && (
          <Text size="xs" c="red.4" pb={8}>
            {error}
          </Text>
        )}
      </Group>

      {players.length > 0 && (
        <Group gap="xs">
          {players.map((player) => {
            const on = player.actorIndex === actorIndex;
            const count = hits.filter((hit) => hit.sourceIndex === player.actorIndex).length;
            return (
              <UnstyledButton
                key={player.actorIndex}
                onClick={() => setActorIndex(player.actorIndex)}
                aria-pressed={on}
                data-cap-actor={player.actorIndex}
                style={{
                  padding: "3px 10px",
                  borderRadius: 3,
                  fontSize: 12,
                  background: on ? "var(--mantine-color-dark-5)" : "var(--mantine-color-dark-7)",
                  border: `1px solid ${on ? "var(--mantine-color-yellow-4)" : "var(--color-line)"}`,
                }}
              >
                {`${player.displayName || translateCharacterType(player.characterType)} (${count})`}
              </UnstyledButton>
            );
          })}
        </Group>
      )}

      {truncated && (
        <Text size="xs" c="orange.4">
          {t("ui.debug.cap-truncated")}
        </Text>
      )}

      <Group align="stretch" gap="md" wrap="nowrap" style={{ flexGrow: 1, minHeight: 0 }}>
        <Box style={{ width: LIST_WIDTH, flexShrink: 0, ...FLEX_COLUMN }}>
          <Text size="xs" c="dimmed" mb={4}>
            {t("ui.debug.cap-hit-count", { count: shown.length })}
          </Text>
          <ScrollArea
            style={{ flexGrow: 1, minHeight: 0, border: "1px solid var(--color-line)", borderRadius: 4 }}
            aria-label={t("ui.debug.cap-hit-list")}
          >
            <Stack gap={0} p={2}>
              {shown.map((hit) => (
                <HitRow
                  key={hit.eventIndex}
                  hit={hit}
                  name={nameOf(hit)}
                  selected={hit.eventIndex === eventIndex}
                  onSelect={() => setEventIndex(hit.eventIndex)}
                />
              ))}
            </Stack>
          </ScrollArea>
        </Box>

        <Box style={{ flex: 1, minWidth: 0, ...FLEX_COLUMN }}>
          {selected === null || hitPanels === null ? (
            <Text size="xs" c="dimmed">
              {t("ui.debug.cap-pick-a-hit")}
            </Text>
          ) : (
            <>
              <Text size="sm" fw={600} mb={2}>
                {hitLabel(selected, nameOf(selected))}
              </Text>
              {/* The wire key alongside the name: this is a debug panel, and
                  the raw action id is what a finding gets quoted by. The damage
                  itself is not repeated here — it is the pipeline's Final cell. */}
              <Text size="xs" c="dimmed" mb="sm">
                {`${millisecondsToPreciseElapsedFormat(selected.timeMs)} · ${selected.abilityKey}`}
              </Text>
              {/* What happened to this hit, before either column's working:
                  pre-cap -> cap -> post-cap -> final, with the clamp drawn. */}
              <HitPipeline hit={selected.hit} />
              {/* Both columns split the detail area evenly and compress with
                  it — the panel rows floor at MIN_ROW_WIDTH, below which each
                  column's own ScrollArea scrolls, so the page never grows a
                  horizontal scrollbar of its own. */}
              <Group align="stretch" gap="md" wrap="nowrap" style={{ flexGrow: 1, minHeight: 0 }}>
                <Box style={{ flex: 1, minWidth: 0, ...FLEX_COLUMN }}>
                  {/* One notch bigger and undimmed vs. CapDetailPanel's own
                      section headings, so "DAMAGE CALCULATION" reads as the
                      column's title rather than as its first section. */}
                  <Text size="sm" fw={700} tt="uppercase" mb={4}>
                    {t("ui.debug.cap-col-cap")}
                  </Text>
                  <ScrollArea offsetScrollbars style={{ flexGrow: 1, minHeight: 0 }}>
                    <CapDetailPanel sections={hitPanels.sections} />
                  </ScrollArea>
                </Box>
                <Box style={{ flex: 1, minWidth: 0, ...FLEX_COLUMN }}>
                  <Text size="sm" fw={700} tt="uppercase" mb={4}>
                    {t("ui.debug.cap-col-damage")}
                  </Text>
                  <ScrollArea offsetScrollbars style={{ flexGrow: 1, minHeight: 0 }}>
                    <CapDetailPanel sections={hitPanels.damageSections} />
                  </ScrollArea>
                </Box>
              </Group>
            </>
          )}
        </Box>
      </Group>
    </Stack>
  );
};
