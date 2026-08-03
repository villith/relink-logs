import type { ComputedPlayerState, EnemyType, SkillState } from "@/types";

import { abilityKey } from "../abilityKey";
import { abilityRowKey, skillsForAbilityKey } from "../abilitySkills";
import type { RowLevel } from "../deriveRows";
import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";

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
};

/** Per-enemy totals summed across a set of skills.
 *
 * `targets` is optional on SkillState because cached payloads predate it. An
 * absent list means the breakdown is unavailable, not that nothing was hit —
 * which is why a missing list yields no entries rather than a zero row. */
export const aggregateTargets = (
  skills: SkillState[],
  enemyLabel: (type: EnemyType) => string,
  enemyIcon?: (type: EnemyType) => string | undefined
) => {
  const byType = new Map<string, { key: string; label: string; value: number; icon?: string }>();
  for (const skill of skills) {
    for (const target of skill.targets ?? []) {
      // JSON, not String(): EnemyType is `string | { Unknown: number }`, and
      // String() renders every Unknown variant as "[object Object]", merging
      // every unidentified spawn into a single row.
      const key = JSON.stringify(target.enemyType);
      const found = byType.get(key);
      if (found) found.value += target.totalDamage;
      else
        byType.set(key, {
          key,
          label: enemyLabel(target.enemyType),
          value: target.totalDamage,
          icon: enemyIcon?.(target.enemyType),
        });
    }
  }
  return [...byType.values()].sort((a, b) => b.value - a.value);
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
  abilityIcon?: (key: string) => string | undefined
) => {
  const byKey = new Map<string, { key: string; label: string; value: number; icon?: string }>();
  for (const skill of skills) {
    const key = abilityRowKey(skill);
    const found = byKey.get(key);
    if (found) found.value += skill.totalDamage;
    else byKey.set(key, { key, label: abilityLabel(key), value: skill.totalDamage, icon: abilityIcon?.(key) });
  }
  return [...byKey.values()].sort((a, b) => b.value - a.value);
};

/** Per-player totals for ONE action, across the whole scoped party.
 *
 * Keyed by the raw action rather than by `abilityRowKey`, because this explains
 * a row at the skills level — one member of a pinned group — and that row is
 * already merged by action id.
 *
 * Each entry carries the player's own colour: a section colour would paint the
 * whole party one shade and lose the only thing this section is for. */
export const aggregateSources = (
  players: ComputedPlayerState[],
  actionKey: string,
  sourceLabel: (index: number) => string,
  sourceColor: (index: number) => string,
  sourceIcon?: (index: number) => string | undefined
) =>
  players
    .map((player) => ({
      key: `source:${player.index}`,
      label: sourceLabel(player.index),
      color: sourceColor(player.index),
      icon: sourceIcon?.(player.index),
      value: player.skillBreakdown
        .filter((skill) => abilityKey(skill.actionType) === actionKey)
        .reduce((sum, skill) => sum + skill.totalDamage, 0),
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

const TARGET_COLOR = "var(--mantine-color-red-6)";

/** The hover card's sections for one row, or null when the row has nothing to
 * decompose.
 *
 * A player is explained by ability and by target. An ability is explained by
 * target alone — the abilities level is reached only with a source pinned, so a
 * source section there would always hold one row at 100%. A member skill is
 * explained by source AND target, because an ability may be pinned with no
 * friendly at all, and then the source is exactly what varies. */
export const cardSectionsFor = ({
  row,
  level,
  players,
  pins,
  color,
  labels,
}: {
  row: MetricRow;
  level: RowLevel;
  players: ComputedPlayerState[];
  pins: SelectorPins;
  /** The row's own colour, so the card matches the bar it came from. */
  color: string;
  labels: SectionLabels;
}): CardSection[] | null => {
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
          labels.abilityIcon && ((key) => labels.abilityIcon?.(key, player))
        ),
      },
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(player.skillBreakdown, labels.enemy, labels.enemyIcon),
      },
    ];
  }

  if (level === "abilities") {
    const owner = players.find((candidate) => candidate.index === pins.source);
    // EVERY skill under the ability, not the first: the row above sums them, so
    // explaining it with one contributor describes a fraction of what it says.
    const skills = skillsForAbilityKey(owner?.skillBreakdown ?? [], row.key.replace(/^skill:/, ""));
    if (skills.length === 0) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(skills, labels.enemy, labels.enemyIcon),
      },
    ];
  }

  if (level === "skills") {
    // One member skill of the pinned ability. What varies is who dealt it and
    // what it hit — the two dimensions the pins have NOT fixed. The source
    // section is shown even when a friendly is pinned and it holds a single row
    // at 100%, so the card keeps its shape as pins change.
    const actionKey = row.key.replace(/^skill:/, "");
    const skills = players.flatMap((player) =>
      player.skillBreakdown.filter((skill) => abilityKey(skill.actionType) === actionKey)
    );
    if (skills.length === 0) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-source",
        color,
        entries: aggregateSources(players, actionKey, labels.source, labels.sourceColor, labels.sourceIcon),
      },
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(skills, labels.enemy, labels.enemyIcon),
      },
    ];
  }

  return null;
};
