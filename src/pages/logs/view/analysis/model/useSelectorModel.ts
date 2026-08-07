import { useCallback, useMemo } from "react";

import { statusIconUrl } from "@/statusIcon";
import type { ActionType, SelectionFact, TargetEntry } from "@/types";

import { abilityKey } from "../../abilityKey";
import { actorColor } from "../../actorColor";
import type { EventLabels } from "../../events/EventsTab";
import type { EventPins } from "../../events/eventRows";
import type { ScopeProbes } from "../../events/eventScope";
import { spawnSegmentAt } from "../../events/eventTargets";
import { isHarmful } from "../../metrics/statusPolarity";
import { deriveSelectorOptions, type SelectorPins } from "../../selectorOptions";
import { isStatusPin } from "../../statusUptime";
import { labelSourceOptions } from "../legendLabel";
import { abilityRowIconUrl } from "../rowIcon";
import { statusIdOfKey } from "../statusLabel";
import { withStatusOption } from "../statusOption";

import type { ActorIdentity } from "./useActorIdentity";

/** The pick lists and the raw event stream's cells.
 *
 * Both are named and pictured through the SAME resolvers the metric table and
 * its hover cards use — that is the whole reason this is one module rather than
 * loose callbacks in the view. A second spelling of any of them would let a
 * dropdown and the row it pins name one actor two different ways, or pair one
 * kind's name with another kind's art. */
export type SelectorModel = {
  /** The Events body's pins, resolved out of the machine's index spaces into
   * the ones a raw event carries. */
  eventPins: EventPins;
  eventLabels: EventLabels;
  eventProbes: ScopeProbes;
  /** The three selector dropdowns, each option already carrying its name, its
   * art and its actor's own colour. */
  labelledOptions: {
    sources: { value: string; label: string; iconUrl?: string; color?: string }[];
    targets: { value: string; label: string; iconUrl?: string; color?: string }[];
    abilities: { value: string; label: string; iconUrl?: string }[];
  };
};

export type SelectorModelInput = {
  facts: SelectionFact[];
  pins: SelectorPins;
  /** A condensed group pin expanded into raw action ids — the same expansion
   * the fetch uses, so a pinned echo filters the stream to the damage its row
   * reports. */
  pinnedActions: ActionType[];
  targetEntries: TargetEntry[];
  identity: ActorIdentity;
  statusDisplayLabel: (key: string) => string;
  playerLabelTemplate: string;
};

export const useSelectorModel = ({
  facts,
  pins,
  pinnedActions,
  targetEntries,
  identity,
  statusDisplayLabel,
  playerLabelTemplate,
}: SelectorModelInput): SelectorModel => {
  const {
    identityPlayers,
    playerByIndex,
    colorContext,
    labelForSource,
    labelForAbility,
    labelForTarget,
    characterForSource,
    sourceIconUrl,
    targetIconUrl,
  } = identity;
  // Cascading options come from the facts for the CURRENT window but with no
  // pin applied — a selector must keep offering what the other pins allow.
  const options = useMemo(() => deriveSelectorOptions(facts, pins), [facts, pins]);

  // The Events body's pins, resolved out of the machine's index spaces into the
  // ones a raw event carries (see `filterByPins`). Declared here because the
  // target dimension needs `targetEntries`' spawn table.
  const eventPins = useMemo(
    () => ({
      // Already the same space as a damage event's `source.parent_index`.
      source: pins.source,
      // A pinned target is a SPAWN, so it travels as BOTH of that spawn's ids
      // plus its span. Both because the rows it filters are not all in one
      // index space (see `ActorSpace`): a damage row carries the folded
      // instance pointer, a status row the game's actor index. The span is what
      // separates a reissued actor index's two spawns.
      targetSpans: pins.targets
        .map((segment) => targetEntries[segment])
        .filter((entry) => entry !== undefined)
        .map((entry) => ({
          spawnId: entry.id,
          actorIndex: entry.actorIndex,
          startMs: entry.startMs,
          endMs: entry.endMs,
        })),
      // `pinnedActions` is the expansion the view already computes for its own
      // fetch, so a condensed `Group:` pin matches the raw ids behind it. An
      // EMPTY set with an ability pinned narrows to nothing, which is the honest
      // answer for a status pin — it names no action at all.
      abilityKeys: pins.ability === null ? null : new Set(pinnedActions.map(abilityKey)),
    }),
    [pins.source, pins.targets, pins.ability, pinnedActions, targetEntries]
  );

  const abilityOptionIconUrl = useCallback(
    (key: string) => {
      // A status pin names an EFFECT, not an action, so it takes the effects
      // table's art rather than the ability map's — which has no entry for it
      // and would answer with whichever action its fallback landed on.
      if (isStatusPin(key)) {
        const statusId = statusIdOfKey(key);
        return statusId === null ? undefined : statusIconUrl(statusId);
      }
      return abilityRowIconUrl(key, identityPlayers, playerByIndex.get(pins.source ?? -1)?.player);
    },
    [identityPlayers, playerByIndex, pins.source]
  );

  // The Events body's cells, named and pictured through the SAME resolvers the
  // metric table and the selectors use — a second spelling of either here would
  // let the two name one actor two ways, or pair one kind's name with another
  // kind's art. Declared HERE, below those resolvers rather than beside
  // `eventPins` above, because it closes over all three of them.
  //
  // ONE actor resolver for both ends of a row. The party is tried first, then
  // the spawn table in the index space the row declares (see `ActorSpace`), at
  // the moment of the event — the parser's own `segment_at` rule. A party
  // member resolves the same way in either space, because both capture paths
  // report one as a slot key.
  //
  // Colour is the point of the split: a player takes their own party colour,
  // an enemy takes its SPAWN's colour from the enemy palette. Neither answers
  // for the other, so a boss can never be drawn in a party member's colour.
  const eventLabels: EventLabels = useMemo(
    () => ({
      actor: (index, atMs, space) => {
        if (playerByIndex.has(index)) {
          return {
            name: labelForSource(index),
            iconUrl: sourceIconUrl(index),
            color: actorColor({ kind: "player", index }, colorContext),
          };
        }
        const segment = spawnSegmentAt(targetEntries, index, atMs, space);
        if (segment !== -1) {
          return {
            name: labelForTarget(segment),
            iconUrl: targetIconUrl(segment),
            color: actorColor({ kind: "spawn", segment }, colorContext),
          };
        }
        // Neither a party member nor a known spawn. The raw index is the honest
        // answer — it is what tells the reader the log holds an actor the
        // segmenter skipped, rather than quietly showing an empty cell. No
        // colour either: an actor we cannot name is not one we can categorise.
        return { name: String(index) };
      },
      // One resolver for the art of both, because `abilityOptionIconUrl` already
      // dispatches on the `status:` prefix — the selector needs the same split.
      ability: (key) => ({ name: labelForAbility(key), iconUrl: abilityOptionIconUrl(key) }),
      status: (key) => ({ name: statusDisplayLabel(key), iconUrl: abilityOptionIconUrl(key) }),
    }),
    [
      labelForSource,
      labelForTarget,
      labelForAbility,
      statusDisplayLabel,
      sourceIconUrl,
      colorContext,
      abilityOptionIconUrl,
      targetEntries,
      playerByIndex,
    ]
  );

  // How the event stream classifies an actor and an effect. Both come straight
  // from what the tables already use — the identity party for membership, the
  // game's own polarity flag for buff-vs-debuff — so the stream and the table
  // above it cannot disagree about who is in the party or what a debuff is.
  const eventProbes: ScopeProbes = useMemo(
    () => ({ isPartyMember: (index) => playerByIndex.has(index), isHarmful }),
    [playerByIndex]
  );

  const labelledOptions = useMemo(
    () => ({
      // Options wear their actor's own colour, the same one the chart band and
      // the table row take — a dropdown is where you pick the thing you are
      // about to look at, so it is the one place the colours must already
      // match. An ability has no actor and stays plain.
      sources: labelSourceOptions(options.sources, labelForSource, characterForSource, playerLabelTemplate).map(
        (option) => ({
          ...option,
          iconUrl: sourceIconUrl(Number(option.value)),
          color: actorColor({ kind: "player", index: Number(option.value) }, colorContext),
        })
      ),
      targets: options.targets.map((option) => ({
        ...option,
        label: labelForTarget(Number(option.value)),
        iconUrl: targetIconUrl(Number(option.value)),
        color: actorColor({ kind: "spawn", segment: Number(option.value) }, colorContext),
      })),
      // Icons AFTER `withStatusOption`, not before: the option it injects for a
      // pinned effect is not in the list it was given, and an icon pass on the
      // input would leave the one option that is definitely selected as the
      // only one with no art.
      abilities: withStatusOption(
        options.abilities.map((option) => ({ ...option, label: labelForAbility(option.value) })),
        pins.ability,
        statusDisplayLabel
      ).map((option) => ({ ...option, iconUrl: abilityOptionIconUrl(option.value) })),
    }),
    [
      options,
      labelForSource,
      characterForSource,
      playerLabelTemplate,
      labelForTarget,
      labelForAbility,
      pins.ability,
      statusDisplayLabel,
      sourceIconUrl,
      abilityOptionIconUrl,
      targetEntries,
      colorContext,
    ]
  );

  return { eventPins, eventLabels, eventProbes, labelledOptions };
};
