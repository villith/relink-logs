import type { CharacterType, ComputedPlayerState, SkillState, SkillTargetState, TargetEntry } from "@/types";

import { abilityKey } from "../abilityKey";
import {
  childOfPin,
  groupSkillsForRows,
  skillsForAbilityKey,
  splitSupplementary,
  type RowKeying,
} from "../abilitySkills";
import type { MetricCard, MetricRow, RowLevel } from "../metrics/types";
import { playerRowKey, spawnRowKey, spawnRowSegment } from "../rowKey";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";
import { foldPartyDealt, sortedEntries } from "./cardFold";
import type { CardLabels } from "./cardLabels";
import { qualifyDuplicateLabels } from "./labelCollision";

/** What the damage cards name and draw with — the view injects them so this
 * stays a pure function: skill and enemy names need i18n, and player names and
 * colours need the settings store. Declared in `cardLabels.ts` with the other
 * cards' lookups, so one field cannot mean two things across two cards. */
export type SectionLabels = Pick<
  CardLabels,
  | "ability"
  | "enemy"
  | "source"
  | "sourceColor"
  | "character"
  | "abilityIcon"
  | "enemyIcon"
  | "sourceIcon"
  | "target"
  | "targetIcon"
>;

/** Per-enemy totals summed across a set of skills.
 *
 * DAMAGE, always: `SkillTargetState` records damage and hits and nothing else,
 * so there is no per-enemy figure for any other metric. Callers gate on
 * `MetricCard.perTarget` rather than passing an accessor here — a metric with
 * no per-enemy record must omit the section, not fill it with damage.
 *
 * Spawn-keyed where an entry carries a `segment` — the same identity the
 * table's target rows use, labelled through the same lookup — and type-keyed
 * for entries from payloads that predate the field, which can only speak at
 * the type level and render un-numbered, or where the segmenter declined to
 * place the event.
 *
 * `targets` is optional on SkillState because cached payloads predate it. An
 * absent list means the breakdown is unavailable, not that nothing was hit —
 * which is why a missing list yields no entries rather than a zero row. */
export const aggregateTargets = (
  skills: SkillState[],
  labels: Pick<SectionLabels, "enemy" | "enemyIcon" | "target" | "targetIcon">
) => {
  const folded = new Map<string, { key: string; label: string; value: number; icon?: string }>();
  for (const skill of skills) {
    for (const target of skill.targets ?? []) {
      // JSON for the type half, not String(): EnemyType is
      // `string | { Unknown: number }`, and String() renders every Unknown
      // variant as "[object Object]", merging every unidentified spawn into
      // a single row.
      const key = target.segment !== undefined ? spawnRowKey(target.segment) : JSON.stringify(target.enemyType);
      const found = folded.get(key);
      if (found) {
        found.value += target.totalDamage;
        continue;
      }
      const label =
        target.segment !== undefined && labels.target ? labels.target(target.segment) : labels.enemy(target.enemyType);
      const icon =
        target.segment !== undefined && labels.targetIcon
          ? labels.targetIcon(target.segment)
          : labels.enemyIcon?.(target.enemyType);
      folded.set(key, { key, label, value: target.totalDamage, icon });
    }
  }
  return [...folded.values()].sort((a, b) => b.value - a.value);
};

/** The echo share of a set of skills, as a `BreakdownEntry` fragment.
 *
 * A card explains the row it is hovering, so an entry that folded an echo has
 * to draw the same two-segment bar that row does. Through `splitSupplementary`,
 * the one author of the rule — a card that split differently would be
 * explaining a row other than the one under the cursor. */
const entrySplit = (skills: SkillState[], valueOf: (skill: SkillState) => number): { subValue?: number } => {
  const { echoes, mixed } = splitSupplementary(skills);
  if (!mixed) return {};
  const supplementary = echoes.reduce((sum, skill) => sum + valueOf(skill), 0);
  // Absent rather than 0, so an entry with no echoes mounts one bar segment.
  return supplementary > 0 ? { subValue: supplementary } : {};
};

/** Per-ability totals, summed across every skill the table would draw as ONE
 * row — condensed into skill groups, exactly like the table beneath the card.
 *
 * The parser emits one `SkillState` per (action, child character), so mapping
 * `skillBreakdown` 1:1 draws an ability twice with its damage split between the
 * rows, and hands React two children with the same key. Measured on log 544:
 * "Link Attack" and "Light Blast" each appeared twice. Same shape as
 * `aggregateTargets`. */
export const aggregateAbilities = (
  skills: SkillState[],
  abilityLabel: (key: string) => string,
  valueOf: (skill: SkillState) => number,
  abilityIcon?: (key: string) => string | undefined,
  characterName?: (type: CharacterType) => string,
  keying?: RowKeying
) => {
  // `groupSkillsForRows` owns the condensing rule; re-deriving it here is what
  // produced the double-draw above in the first place. The view's keying rides
  // along for the same reason: a card that folded echoes differently from the
  // table beneath it would explain a row that is not the one being hovered.
  const entries = groupSkillsForRows(skills, keying).map(({ key, skills: grouped }) => ({
    key,
    label: abilityLabel(key),
    value: grouped.reduce((sum, skill) => sum + valueOf(skill), 0),
    ...entrySplit(grouped, valueOf),
    icon: abilityIcon?.(key),
  }));
  // Two same-named groups from different bodies (Id vs his dragonform) read
  // identically; the collision-only qualifier names the body — the same rule
  // the table's parent rows apply, through the same helper.
  const labels = qualifyDuplicateLabels(
    entries.map((entry) => {
      if (!characterName) return { label: entry.label, qualifier: "" };
      const child = childOfPin(entry.key);
      return { label: entry.label, qualifier: child === null ? "" : characterName(child) };
    })
  );
  return entries.map((entry, position) => ({ ...entry, label: labels[position] })).sort((a, b) => b.value - a.value);
};

/** Per-player totals for one row's skills, across the whole scoped party.
 *
 * `skillsOf` names each player's contributing breakdown rows — an action-key
 * match at the skills level, an ability-row match (skill groups included) at
 * the abilities level — so one fold serves both without re-deriving either
 * grouping rule here.
 *
 * Each entry carries the player's own colour: a section colour would paint the
 * whole party one shade and lose the only thing this section is for. */
export const aggregateSources = (
  players: ComputedPlayerState[],
  skillsOf: (player: ComputedPlayerState) => SkillState[],
  sourceLabel: (index: number) => string,
  sourceColor: (index: number) => string,
  valueOf: (skill: SkillState) => number,
  sourceIcon?: (index: number) => string | undefined
) =>
  players
    .map((player) => {
      // Once, not twice: the value and its echo share come from the same list,
      // and `skillsOf` filters a whole breakdown per call.
      const skills = skillsOf(player);
      return {
        key: playerRowKey(player.index),
        label: sourceLabel(player.index),
        color: sourceColor(player.index),
        icon: sourceIcon?.(player.index),
        value: skills.reduce((sum, skill) => sum + valueOf(skill), 0),
        // This player's OWN echo share — the section splits one row across the
        // party, so each entry answers for the echoes it actually dealt.
        ...entrySplit(skills, valueOf),
      };
    })
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

const TARGET_COLOR = "var(--mantine-color-red-6)";

/** The hover card's sections for one row, or null when the row has nothing to
 * decompose.
 *
 * The rule: sections are the dimensions the pins have NOT fixed. A player is
 * explained by ability and by target. An ability is explained by target — and
 * by source too when no source is pinned, because the RegroupStrip reaches
 * the abilities level party-wide ("Done by ability"). A member skill is
 * explained by source AND target, because an ability may be pinned with no
 * friendly at all, and then the source is exactly what varies. */
export const cardSectionsFor = ({
  row,
  level,
  players,
  pins,
  color,
  labels,
  card,
  keying,
}: {
  row: MetricRow;
  level: RowLevel;
  players: ComputedPlayerState[];
  pins: SelectorPins;
  /** The row's own colour, so the card matches the bar it came from. */
  color: string;
  labels: SectionLabels;
  /** The view's row keying, so the card folds exactly as the row it explains. */
  keying?: RowKeying;
  /** What the card measures. Every figure below is read through
   * `card.valueOf`, and the by-target section is omitted outright where the
   * metric has no per-enemy record — see `aggregateTargets`. */
  card: MetricCard;
}): CardSection[] | null => {
  // Only where the metric HAS a per-enemy record. Omitted rather than zeroed:
  // a stun card with an empty "Target" heading suggests the ability hit
  // nothing, and one filled from `SkillTargetState.totalDamage` would print
  // damage under a stun heading.
  const targetSection = (skills: SkillState[]): CardSection[] =>
    card.perTarget
      ? [
          {
            headingKey: "ui.logs.hover-by-target",
            color: TARGET_COLOR,
            entries: aggregateTargets(skills, labels),
          },
        ]
      : [];

  if (level === "players") {
    const player = players.find((candidate) => playerRowKey(candidate.index) === row.key);
    if (!player) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-ability",
        color,
        entries: aggregateAbilities(
          player.skillBreakdown,
          (key) => labels.ability(key, player),
          card.valueOf,
          labels.abilityIcon && ((key) => labels.abilityIcon?.(key, player)),
          labels.character,
          keying
        ),
      },
      ...targetSection(player.skillBreakdown),
    ];
  }

  if (level === "abilities") {
    // Owner = the pinned player if any, else the whole party: the
    // RegroupStrip's "Done by ability" reaches this level with NO source
    // pinned. A pinned source missing from the scoped party still has
    // genuinely nothing to show.
    const owner = players.find((candidate) => candidate.index === pins.source);
    if (pins.source !== null && !owner) return null;
    const scoped = owner ? [owner] : players;
    const rowKey = row.key.replace(/^skill:/, "");
    const skillsOf = (player: ComputedPlayerState) => skillsForAbilityKey(player.skillBreakdown, rowKey, keying);
    // EVERY skill under the ability, not the first: the row above sums them, so
    // explaining it with one contributor describes a fraction of what it says.
    const skills = scoped.flatMap(skillsOf);
    if (skills.length === 0) return null;

    const sections: CardSection[] = [];
    // Party-wide, who dealt it is a free dimension — the by-source section is
    // what stands in for Warcraft Logs' per-source nested rows. With an owner
    // pinned it would always be one row at 100%, so it is omitted there.
    if (!owner) {
      sections.push({
        headingKey: "ui.logs.hover-by-source",
        color,
        entries: aggregateSources(scoped, skillsOf, labels.source, labels.sourceColor, card.valueOf, labels.sourceIcon),
      });
    }
    sections.push(...targetSection(skills));
    return sections.length === 0 ? null : sections;
  }

  if (level === "skills") {
    // One member skill of the pinned ability. What varies is who dealt it and
    // what it hit — the two dimensions the pins have NOT fixed. The source
    // section is shown even when a friendly is pinned and it holds a single row
    // at 100%, so the card keeps its shape as pins change.
    //
    // A row the descriptor decomposed some other way (an enemy row, whose key
    // names a type rather than an action) matches no skill and falls out here.
    const actionKey = row.key.replace(/^skill:/, "");
    const skills = players.flatMap((player) =>
      player.skillBreakdown.filter((skill) => abilityKey(skill.actionType) === actionKey)
    );
    if (skills.length === 0) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-source",
        color,
        entries: aggregateSources(
          players,
          (player) => player.skillBreakdown.filter((skill) => abilityKey(skill.actionType) === actionKey),
          labels.source,
          labels.sourceColor,
          card.valueOf,
          labels.sourceIcon
        ),
      },
      ...targetSection(skills),
    ];
  }

  return null;
};

/** Damage, friendly side: one enemy SPAWN row ("Done to enemy", and the
 * source+ability drill's rows) explained by what hit it and who dealt that —
 * the two dimensions a target pin leaves free, which is why declaring these
 * rows `"none"` was wrong (WCL comparison §3.3).
 *
 * Aggregated from every scoped player's skills' target entries matching the
 * row's spawn segment. An entry without a segment (a payload from before the
 * field) matches by the spawn's TYPE instead — exact for a lone spawn, and
 * the same same-type-spawns-merge approximation the taken tab already
 * documents for data that cannot speak per spawn. A segment-less entry can
 * also come from a CURRENT payload the segmenter declined to place; that
 * unplaced damage lands in every same-type spawn's card, so a card can total
 * slightly more than its row.
 *
 * Damage figures only, deliberately: `SkillTargetState` records damage and
 * hits and nothing else, and only the damage tab declares this card. */
export const targetCardSectionsFor = ({
  row,
  players,
  targetEntries,
  color,
  labels,
  keying,
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The response's spawn vector, for resolving the row's segment to a type. */
  targetEntries: TargetEntry[];
  /** The row's own colour, so the by-ability section matches its bar. */
  color: string;
  labels: SectionLabels;
  /** The view's row keying, so an echo rides its cause here exactly as it does
   * in the table this card explains. */
  keying?: RowKeying;
}): CardSection[] | null => {
  const segment = spawnRowSegment(row.key);
  if (segment === null) return null;
  const entry = targetEntries[segment];
  // A stale segment indexes nothing — no card rather than a guess, the same
  // convention the target-span filter uses for a stale URL.
  if (!entry) return null;
  const typeKey = JSON.stringify(entry.enemyType);

  // An entry without a segment matches by the spawn's TYPE instead — the
  // approximation the doc comment above describes.
  const matches = (target: SkillTargetState): boolean =>
    target.segment !== undefined ? target.segment === segment : JSON.stringify(target.enemyType) === typeKey;

  const { bySource, byAbility } = foldPartyDealt(players, matches, labels, keying);
  // Nothing recorded against this spawn — no card, rather than an empty one.
  if (bySource.length === 0) return null;

  return [
    { headingKey: "ui.logs.hover-by-ability", color, entries: sortedEntries(byAbility) },
    { headingKey: "ui.logs.hover-by-source", color, entries: sortedEntries(bySource) },
  ];
};
