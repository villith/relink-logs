import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { characterIconUrl } from "@/characterIcon";
import { emKeyOf, enemyAttackOrdinal } from "@/enemyAttackNames";
import { enemyIconUrl } from "@/enemyIcon";
import type {
  ActionType,
  CharacterType,
  ComputedPlayerState,
  EncounterState,
  EnemyType,
  PlayerData,
  TargetEntry,
} from "@/types";
import {
  PLAYER_COLORS,
  getSkillName,
  resolvePlayerColor,
  targetLabelKey,
  translateCharacterType,
  translateEnemyType,
  translatedPlayerName,
} from "@/utils";

import { type ActorColorContext } from "../../actorColor";
import { takenAttackNameKey } from "../../metrics/damageTaken";
import { buildTargetLabels } from "../../targetLabels";
import { abilityLabelFor } from "../abilityLabel";
import { identityPartyOf } from "../partyIdentity";

/** One party member reduced to what the identity helpers need.
 *
 * Deliberately NOT `ComputedPlayerState`: these helpers run per row and per
 * dropdown option, and a narrow shape keeps them testable without building a
 * whole encounter. */
export type IdentityEntry = { slot: number; characterType: CharacterType };

/** A member's portrait, or undefined for anyone the party does not hold.
 *
 * ONE site, replacing three identical spellings in the view — the source
 * option's art, the player row's art, and the hover card's source art. A row
 * and the option that pins it must not show two different pictures of one
 * player.
 *
 * The `typeof` guard is load-bearing: `CharacterType` is `string | { Unknown:
 * number }` on the wire, and an Unknown variant sent through the lookup would
 * stringify to "[object Object]" and match nothing — silently, with no icon
 * and no error. */
export const characterIconFor = (byIndex: Map<number, IdentityEntry>, index: number): string | undefined => {
  const character = byIndex.get(index)?.characterType;
  return typeof character === "string" ? characterIconUrl(character) : undefined;
};

/** A player's own party colour.
 *
 * `fallbackSlot` is a parameter because it is the ONLY thing that differed
 * between the three call sites this replaces: a table row falls back to its
 * own `colorSlot`, a bare player index to slot 0. Collapsing them onto one
 * fallback would have recoloured one of the two.
 *
 * Resolved through the IDENTITY party by every caller, so a scoped fetch's
 * renumbered slots cannot recolour a player mid-drill. */
export const slotColor = (
  palette: string[],
  partyData: Array<PlayerData | null>,
  byIndex: Map<number, IdentityEntry>,
  index: number,
  fallbackSlot: number
): string => resolvePlayerColor(palette, partyData, byIndex.get(index)?.slot ?? fallbackSlot, 0);

/** A spawn's portrait, by segment.
 *
 * Undefined is the common answer, not a failure: only the boss roster has
 * portraits at all (see enemyIcon.ts). ONE site, replacing four. */
export const spawnIcon = (targetEntries: TargetEntry[], segment: number): string | undefined =>
  enemyIconUrl(targetEntries[segment]?.enemyType ?? null);

/** Everything the view names, pictures and colours an actor with.
 *
 * One bundle rather than fifteen loose callbacks threaded through the view: the
 * chart's bands, the table's rows, the selectors' options, the hover cards and
 * the events stream all resolve through these, and a second spelling of any of
 * them is how one actor comes to be named two ways in two places. */
export type ActorIdentity = {
  identityPlayers: ComputedPlayerState[];
  playerByIndex: Map<number, { player: ComputedPlayerState; slot: number }>;
  /** The four user colours, for the chart legend's per-player entries. */
  colors: string[];
  /** Those four plus the shared tail — the eight-entry band palette. */
  palette: string[];
  colorContext: ActorColorContext;
  labelForSource: (index: number) => string;
  labelForAbility: (key: string) => string;
  labelForTarget: (segment: number) => string;
  labelForTakenAttack: (enemyType: EnemyType, actionId: ActionType) => string;
  characterForSource: (index: number) => string;
  sourceIconUrl: (index: number) => string | undefined;
  targetIconUrl: (segment: number) => string | undefined;
  /** A player's party colour, with the caller's own fallback slot. */
  playerColor: (index: number, fallbackSlot: number) => string;
  breakEnemyOf: (actorIndex: number | null, span: { startMs: number; endMs: number }) => string | null;
  enemyTypeAt: (actorIndex: number, atMs: number) => EnemyType | null;
};

export type ActorIdentityInput = {
  /** The FULL party's encounter, for identity. */
  encounter: EncounterState | null;
  /** The scoped one, whose party a pin may have shrunk. */
  shownEncounter: EncounterState | null;
  targetEntries: TargetEntry[];
  playerData: Array<PlayerData | null>;
  /** The pinned source, whose skill tables win when naming a shared action id. */
  sourcePin: number | null;
  settings: {
    show_display_names: boolean;
    streamer_mode: boolean;
    player_label_template: string;
    color_1: string;
    color_2: string;
    color_3: string;
    color_4: string;
  };
};

export const useActorIdentity = ({
  encounter,
  shownEncounter,
  targetEntries,
  playerData,
  sourcePin,
  settings,
}: ActorIdentityInput): ActorIdentity => {
  const { t, i18n } = useTranslation();
  const { show_display_names, streamer_mode, player_label_template, color_1, color_2, color_3, color_4 } = settings;

  // Identity — names, party slots, colours — always from the FULL party, so a
  // pin cannot promote the pinned player to slot 0 and steal slot 0's name and
  // colour.
  const identityPlayers = useMemo(
    () => identityPartyOf(encounter?.party ?? null, shownEncounter?.party ?? null),
    [encounter, shownEncounter]
  );

  // The party palette. One palette, so a player is the same colour in the plot,
  // the table and the raw stream.
  const colors = useMemo(() => [color_1, color_2, color_3, color_4], [color_1, color_2, color_3, color_4]);

  // The eight-entry palette the chart already draws with, so a player is the
  // same colour in the table as in the plot above it.
  const palette = useMemo(() => [...colors, ...PLAYER_COLORS.slice(4)], [colors]);

  // Player labels are looked up by actor index, which is what a pin carries.
  const playerByIndex = useMemo(() => {
    const byIndex = new Map<number, { player: ComputedPlayerState; slot: number }>();
    identityPlayers.forEach((player) => byIndex.set(player.index, { player, slot: player.partyIndex }));
    return byIndex;
  }, [identityPlayers]);

  // The narrow view of the same map, for the three shared helpers above.
  const identityByIndex = useMemo(() => {
    const byIndex = new Map<number, IdentityEntry>();
    playerByIndex.forEach((found, index) =>
      byIndex.set(index, { slot: found.slot, characterType: found.player.characterType })
    );
    return byIndex;
  }, [playerByIndex]);

  const labelForSource = useCallback(
    (index: number) => {
      const found = playerByIndex.get(index);
      if (!found) return String(index);
      return translatedPlayerName(
        found.slot,
        playerData[found.slot] ?? null,
        found.player,
        show_display_names && !streamer_mode,
        player_label_template
      );
    },
    [playerByIndex, playerData, show_display_names, streamer_mode, player_label_template]
  );

  // Skill names are per character, so an ability is named against the first
  // player who used it. identityPlayers, not the scoped party: the options span
  // the whole fight while a scoped one holds only the pinned player, so
  // searching the scoped one left every other player's abilities showing their
  // raw key.
  const labelForAbility = useCallback(
    // The pinned source is preferred: with one pinned the rows and options are
    // that player's own, and a shared action id must take THEIR skill's name.
    (key: string) => abilityLabelFor(key, identityPlayers, getSkillName, playerByIndex.get(sourcePin ?? -1)?.player),
    // i18n.language: skill names are translated, so a language switch must
    // re-derive them even though it is not read here directly.
    [identityPlayers, playerByIndex, sourcePin, i18n.language]
  );

  // One enemy attack, named as "<Enemy> — Attack <id>": enemy actions carry no
  // names in the game data, so the id plus the attacker is the honest label.
  const labelForTakenAttack = useCallback(
    (enemyType: EnemyType, actionId: ActionType) => {
      // A derived callout name wins; the raw id is the fallback, not a peer.
      // Most attacks have no derived pair (the id→ordinal edge is live-capture
      // work), so this falls through to "Attack N" far more often than not.
      const ordinal = enemyAttackOrdinal(enemyType, actionId);
      const emKey = ordinal === null ? null : emKeyOf(enemyType);
      if (ordinal !== null && emKey !== null) {
        const name = t(`enemy-attacks:${emKey}.${ordinal}`, { defaultValue: "" });
        if (name !== "") return `${translateEnemyType(enemyType)} — ${name}`;
      }
      const { key, params } = takenAttackNameKey(actionId);
      return `${translateEnemyType(enemyType)} — ${t(key, params)}`;
    },
    // i18n.language: both the enemy and the attack names are translated.
    [t, i18n.language]
  );

  // The same rule the quest view's HP-chart legend and target filter label with,
  // so one enemy reads the same way everywhere: "#n" only once a name repeats.
  const targetLabels = useMemo(
    () => buildTargetLabels(targetEntries, translateEnemyType),
    // i18n.language: the labels embed translated enemy names.
    [targetEntries, i18n.language]
  );

  // Indexed, not searched by id: two spawns can share a recycled actor id, and
  // `find` then answered with the first of them for both — which is how one of
  // the Four Dragons lost its name and the other took its damage.
  const labelForTarget = useCallback(
    (segment: number) => {
      const entry = targetEntries[segment];
      if (!entry) return String(segment);
      return targetLabels.get(targetLabelKey(entry.enemyType, entry.instance)) ?? translateEnemyType(entry.enemyType);
    },
    [targetEntries, targetLabels]
  );

  // The breaking enemy's display name, through the same spawn table the target
  // rows use — matched on actor index AND time overlap, because the game
  // reissues a dead boss's actor index to a later spawn.
  const breakEnemyOf = useCallback(
    (actorIndex: number | null, span: { startMs: number; endMs: number }): string | null => {
      if (actorIndex === null) return null;
      const segment = targetEntries.findIndex(
        (entry) => entry.actorIndex === actorIndex && entry.startMs < span.endMs && entry.endMs > span.startMs
      );
      return segment === -1 ? null : labelForTarget(segment);
    },
    [targetEntries, labelForTarget]
  );

  // The enemy TYPE at an actor index and a moment, for the taken tab's lanes.
  // Matched on index AND time overlap for the same reason `breakEnemyOf` is:
  // the game reissues a dead boss's actor index to a later spawn, and an
  // index-only lookup files the second boss's attacks under the first's lane.
  const enemyTypeAt = useCallback(
    (actorIndex: number, atMs: number): EnemyType | null => {
      const entry = targetEntries.find(
        (candidate) => candidate.actorIndex === actorIndex && candidate.startMs <= atMs && candidate.endMs >= atMs
      );
      return entry?.enemyType ?? null;
    },
    [targetEntries]
  );

  // A dropdown entry carries no rank, position or colour, so two players the
  // template renders identically ("AI" under a {name}-only template) are told
  // apart by character — the same rule the chart legend labels with.
  const characterForSource = useCallback(
    (index: number) => {
      const found = playerByIndex.get(index);
      return found ? translateCharacterType(found.player.characterType) : "";
    },
    // i18n.language: character names are translated.
    [playerByIndex, i18n.language]
  );

  // The three shared resolvers, bound to this fight's lookups.
  const sourceIconUrl = useCallback((index: number) => characterIconFor(identityByIndex, index), [identityByIndex]);
  const targetIconUrl = useCallback((segment: number) => spawnIcon(targetEntries, segment), [targetEntries]);
  const playerColor = useCallback(
    (index: number, fallbackSlot: number) => slotColor(palette, playerData, identityByIndex, index, fallbackSlot),
    [palette, playerData, identityByIndex]
  );

  // What every actor colour in the view is resolved against — the chart's
  // bands, the table's rows, the pin selectors' options and the events stream
  // all go through `actorColor` with this. One context so a boss cannot be pink
  // in the plot, grey in the table and uncoloured in the dropdown.
  //
  // `slotOf` reads the IDENTITY party, so a scoped fetch's renumbered slots
  // cannot recolour a player mid-drill, and answers `undefined` for a
  // non-member rather than falling back to slot 0 — which would paint every
  // enemy in the first player's colour.
  const colorContext: ActorColorContext = useMemo(
    () => ({ palette, partyData: playerData, slotOf: (index) => playerByIndex.get(index)?.slot }),
    [palette, playerData, playerByIndex]
  );

  return {
    identityPlayers,
    playerByIndex,
    colors,
    palette,
    colorContext,
    labelForSource,
    labelForAbility,
    labelForTarget,
    labelForTakenAttack,
    characterForSource,
    sourceIconUrl,
    targetIconUrl,
    playerColor,
    breakEnemyOf,
    enemyTypeAt,
  };
};
