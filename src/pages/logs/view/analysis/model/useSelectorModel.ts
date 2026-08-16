import { useCallback, useMemo } from "react";

import type { ActionType, SelectionFact, TargetEntry } from "@/types";

import { abilityKey } from "../../abilityKey";
import { optionOfCell } from "../../entity";
import type { EventPins } from "../../events/eventRows";
import type { ScopeProbes } from "../../events/eventScope";
import type { EventLabels } from "../../events/EventsTab";
import { spawnSegmentAt } from "../../events/eventTargets";
import { isHarmful } from "../../metrics/statusPolarity";
import type { Hostility } from "../../metrics/types";
import { playerRowKey, spawnRowKey } from "../../rowKey";
import { deriveSelectorOptions, type SelectorPins } from "../../selectorOptions";
import { isStatusPin } from "../../statusUptime";
import { labelSourceOptions } from "../legendLabel";
import { universeOf } from "../machine/resolve";
import { withStatusOption } from "../statusOption";

import type { ActorIdentity } from "./useActorIdentity";
import type { EntityCells } from "./useEntityCells";

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
  /** The EFFECTIVE side (a metric with no enemy side reads friendly). It decides
   * which population each of the two actor selectors draws from, and therefore
   * how each option is named, illustrated and coloured — see `universeOf`. */
  hostility: Hostility;
  /** A condensed group pin expanded into raw action ids — the same expansion
   * the fetch uses, so a pinned echo filters the stream to the damage its row
   * reports. */
  pinnedActions: ActionType[];
  targetEntries: TargetEntry[];
  identity: ActorIdentity;
  /** The view's one set of entity lookups — the same bundle the table and the
   * chart resolve through, so a dropdown entry and the row it pins cannot be
   * named, illustrated or coloured differently. */
  cells: EntityCells;
  playerLabelTemplate: string;
};

export const useSelectorModel = ({
  facts,
  pins,
  hostility,
  pinnedActions,
  targetEntries,
  identity,
  cells,
  playerLabelTemplate,
}: SelectorModelInput): SelectorModel => {
  // Only what the OPTIONS themselves need beyond the bundle: the party for
  // membership, and the character namer the legend rule qualifies with.
  const { playerByIndex, labelForSource, characterForSource } = identity;
  const { cellOf, resolvers } = cells;
  // Cascading options come from the facts for the CURRENT window but with no
  // pin applied — a selector must keep offering what the other pins allow.
  const options = useMemo(() => deriveSelectorOptions(facts, pins, hostility), [facts, pins, hostility]);

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

  // An Ability option is either an effect or an action, and the two take
  // different art — a status pin resolved through the ability map has no entry
  // there and would answer with whichever action the fallback landed on. The
  // grammar already tells them apart, so the option asks the one ladder rather
  // than re-testing the prefix here.
  const abilityOptionCell = useCallback(
    (key: string) => (isStatusPin(key) ? resolvers.status(key) : resolvers.ability(key)),
    [resolvers]
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
        if (playerByIndex.has(index)) return resolvers.player(index);
        const segment = spawnSegmentAt(targetEntries, index, atMs, space);
        if (segment !== -1) return resolvers.target(segment);
        // Neither a party member nor a known spawn. The raw index is the honest
        // answer — it is what tells the reader the log holds an actor the
        // segmenter skipped, rather than quietly showing an empty cell. No
        // colour either: an actor we cannot name is not one we can categorise.
        return { name: String(index) };
      },
      // One resolver for both, because the grammar already tells an effect from
      // an action — the stream needs exactly the split the selector needs.
      ability: abilityOptionCell,
      status: abilityOptionCell,
    }),
    [resolvers, abilityOptionCell, targetEntries, playerByIndex]
  );

  // How the event stream classifies an actor and an effect. Both come straight
  // from what the tables already use — the identity party for membership, the
  // game's own polarity flag for buff-vs-debuff — so the stream and the table
  // above it cannot disagree about who is in the party or what a debuff is.
  const eventProbes: ScopeProbes = useMemo(
    () => ({ isPartyMember: (index) => playerByIndex.has(index), isHarmful }),
    [playerByIndex]
  );

  /** The party, named the way the legend names it: two players a template
   * renders identically are told apart by character, which the entity ladder
   * (naming one actor at a time) cannot know about. The art and the colour still
   * come from the ladder, so they cannot drift from the row this option pins. */
  const playerOptionsOf = useCallback(
    (list: typeof options.sources) =>
      labelSourceOptions(list, labelForSource, characterForSource, playerLabelTemplate).map((option) =>
        optionOfCell(option.value, { ...cellOf(playerRowKey(Number(option.value))), name: option.label })
      ),
    [labelForSource, characterForSource, playerLabelTemplate, cellOf]
  );

  /** The fight's enemy spawns — one entry per spawn, never per actor id: the
   * game reissues a dead boss's index to the next one. */
  const spawnOptionsOf = useCallback(
    (list: typeof options.targets) =>
      list.map((option) => optionOfCell(option.value, cellOf(spawnRowKey(Number(option.value))))),
    [cellOf]
  );

  const labelledOptions = useMemo(() => {
    // WHICH population each actor dimension draws from — the same rule the group
    // query resolves its own refs through, so a dropdown entry and the row it
    // pins are the same thing in the same index space. Read off `universeOf`
    // rather than off a second `hostility === "enemy"` here: an option named
    // through the wrong universe does not throw, it just shows a player's name
    // and colour on an enemy spawn.
    const sourcesArePlayers = universeOf("source", hostility) === "player";

    return {
      // Options wear their actor's own colour, the same one the chart band and
      // the table row take — a dropdown is where you pick the thing you are
      // about to look at, so it is the one place the colours must already
      // match. An ability has no actor and stays plain.
      sources: sourcesArePlayers ? playerOptionsOf(options.sources) : spawnOptionsOf(options.sources),
      targets: sourcesArePlayers ? spawnOptionsOf(options.targets) : playerOptionsOf(options.targets),
      // Icons AFTER `withStatusOption`, not before: the option it injects for a
      // pinned effect is not in the list it was given, and an icon pass on the
      // input would leave the one option that is definitely selected as the
      // only one with no art.
      abilities: withStatusOption(
        options.abilities.map((option) => ({ ...option, label: abilityOptionCell(option.value).name })),
        pins.ability,
        (key) => resolvers.status(key).name
      ).map((option) => ({ ...option, iconUrl: abilityOptionCell(option.value).iconUrl })),
    };
  }, [options, hostility, playerOptionsOf, spawnOptionsOf, pins.ability, abilityOptionCell, resolvers]);

  return { eventPins, eventLabels, eventProbes, labelledOptions };
};
