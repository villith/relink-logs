import type { ComputedPlayerState, EnemyType, SkillState, SkillTargetState, TargetEntry } from "@/types";

import { abilityKey } from "../abilityKey";
import { groupSkillsForRows, skillsForAbilityKey } from "../abilitySkills";
import type { MetricCard, MetricRow, RowLevel } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";
import { targetRowSegment } from "./statusLabel";

/** Name lookups the view injects, so this stays a pure function: skill and
 * enemy names need i18n, and player names and colours need the settings store. */
export type SectionLabels = {
  /** `owner` is the player whose breakdown the key is being named for, where
   * the card knows one — action ids collide across characters (120 is
   * Eustace's "Grade 1 Shot" AND Id's "Combo Finisher (Dragonform)"), so a
   * player card's abilities must be named against that player's own table,
   * not the first party member to share the id. */
  ability: (key: string, owner?: ComputedPlayerState) => string;
  enemy: (type: EnemyType) => string;
  /** A player's display name, honouring streamer mode and the label template. */
  source: (index: number) => string;
  /** That player's own party colour, so a source row matches their bar. */
  sourceColor: (index: number) => string;
  /** The entities' art, all optional so tests and older callers stay
   * text-only. The ability icon takes the owner for the same collision reason
   * the ability NAME does. */
  abilityIcon?: (key: string, owner?: ComputedPlayerState) => string | undefined;
  enemyIcon?: (type: EnemyType) => string | undefined;
  sourceIcon?: (index: number) => string | undefined;
  /** One enemy SPAWN's display name (name + "#N" once a name repeats) — the
   * SAME labelling the table's target rows resolve through, injected so the
   * card's "#2" and the table's "#2" can never name different spawns.
   * Optional so tests and older callers fall back to the type name. */
  target?: (segment: number) => string;
  /** That spawn's portrait, resolved through `targetEntries` by the view. */
  targetIcon?: (segment: number) => string | undefined;
};

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
      const key = target.segment !== undefined ? `target:${target.segment}` : JSON.stringify(target.enemyType);
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
  abilityIcon?: (key: string) => string | undefined
) => {
  // `groupSkillsForRows` owns the condensing rule; re-deriving it here is what
  // produced the double-draw above in the first place.
  return groupSkillsForRows(skills)
    .map(({ key, skills: grouped }) => ({
      key,
      label: abilityLabel(key),
      value: grouped.reduce((sum, skill) => sum + valueOf(skill), 0),
      icon: abilityIcon?.(key),
    }))
    .sort((a, b) => b.value - a.value);
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
    .map((player) => ({
      key: `source:${player.index}`,
      label: sourceLabel(player.index),
      color: sourceColor(player.index),
      icon: sourceIcon?.(player.index),
      value: skillsOf(player).reduce((sum, skill) => sum + valueOf(skill), 0),
    }))
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
}: {
  row: MetricRow;
  level: RowLevel;
  players: ComputedPlayerState[];
  pins: SelectorPins;
  /** The row's own colour, so the card matches the bar it came from. */
  color: string;
  labels: SectionLabels;
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
    const player = players.find((candidate) => `player:${candidate.index}` === row.key);
    if (!player) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-ability",
        color,
        entries: aggregateAbilities(
          player.skillBreakdown,
          (key) => labels.ability(key, player),
          card.valueOf,
          labels.abilityIcon && ((key) => labels.abilityIcon?.(key, player))
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
    const skillsOf = (player: ComputedPlayerState) => skillsForAbilityKey(player.skillBreakdown, rowKey);
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

const sortedEntries = <T extends { value: number }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => b.value - a.value);

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
}: {
  row: MetricRow;
  players: ComputedPlayerState[];
  /** The response's spawn vector, for resolving the row's segment to a type. */
  targetEntries: TargetEntry[];
  /** The row's own colour, so the by-ability section matches its bar. */
  color: string;
  labels: SectionLabels;
}): CardSection[] | null => {
  const segment = targetRowSegment(row.key);
  if (segment === null) return null;
  const entry = targetEntries[segment];
  // A stale segment indexes nothing — no card rather than a guess, the same
  // convention the target-span filter uses for a stale URL.
  if (!entry) return null;
  const typeKey = JSON.stringify(entry.enemyType);

  const matches = (target: SkillTargetState): boolean =>
    target.segment !== undefined ? target.segment === segment : JSON.stringify(target.enemyType) === typeKey;

  const bySource: { key: string; label: string; value: number; color: string; icon?: string }[] = [];
  const byAbility = new Map<string, { label: string; value: number; icon?: string }>();
  for (const player of players) {
    let dealt = 0;
    for (const skill of player.skillBreakdown) {
      let skillDealt = 0;
      // `targets` is optional because cached payloads predate it; an absent
      // list means the breakdown is unavailable, not that nothing was hit.
      for (const target of skill.targets ?? []) {
        if (matches(target)) skillDealt += target.totalDamage;
      }
      if (skillDealt === 0) continue;
      dealt += skillDealt;
      // Keyed by the raw action, and named against its OWN player: the parser
      // emits one `SkillState` per (action, child character), so this also
      // merges a player and their summon back into the one ability — the
      // same fold `enemyReceivedCardSectionsFor` uses.
      const key = abilityKey(skill.actionType);
      const ability = byAbility.get(key);
      if (ability) ability.value += skillDealt;
      else
        byAbility.set(key, {
          label: labels.ability(key, player),
          value: skillDealt,
          icon: labels.abilityIcon?.(key, player),
        });
    }
    if (dealt > 0) {
      bySource.push({
        key: `source:${player.index}`,
        label: labels.source(player.index),
        value: dealt,
        // Each player in their OWN party colour: one colour across the
        // section would lose the only thing it is for.
        color: labels.sourceColor(player.index),
        icon: labels.sourceIcon?.(player.index),
      });
    }
  }
  // Nothing recorded against this spawn — no card, rather than an empty one.
  if (bySource.length === 0) return null;

  return [
    {
      headingKey: "ui.logs.hover-by-ability",
      color,
      entries: sortedEntries([...byAbility.entries()].map(([key, ability]) => ({ key, ...ability }))),
    },
    { headingKey: "ui.logs.hover-by-source", color, entries: sortedEntries(bySource) },
  ];
};
