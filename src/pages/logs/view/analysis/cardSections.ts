import type { ComputedPlayerState, EnemyType, SkillState } from "@/types";

import { abilityKey } from "../abilityKey";
import { skillsForAbility } from "../abilitySkills";
import type { RowLevel } from "../deriveRows";
import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";

/** Name lookups the view injects, so this stays a pure function: skill and
 * enemy names need i18n, and player names and colours need the settings store. */
export type SectionLabels = {
  ability: (key: string) => string;
  enemy: (type: EnemyType) => string;
  /** A player's display name, honouring streamer mode and the label template. */
  source: (index: number) => string;
  /** That player's own party colour, so a source row matches their bar. */
  sourceColor: (index: number) => string;
};

/** Per-enemy totals summed across a set of skills.
 *
 * `targets` is optional on SkillState because cached payloads predate it. An
 * absent list means the breakdown is unavailable, not that nothing was hit —
 * which is why a missing list yields no entries rather than a zero row. */
export const aggregateTargets = (skills: SkillState[], enemyLabel: (type: EnemyType) => string) => {
  const byType = new Map<string, { key: string; label: string; value: number }>();
  for (const skill of skills) {
    for (const target of skill.targets ?? []) {
      // JSON, not String(): EnemyType is `string | { Unknown: number }`, and
      // String() renders every Unknown variant as "[object Object]", merging
      // every unidentified spawn into a single row.
      const key = JSON.stringify(target.enemyType);
      const found = byType.get(key);
      if (found) found.value += target.totalDamage;
      else byType.set(key, { key, label: enemyLabel(target.enemyType), value: target.totalDamage });
    }
  }
  return [...byType.values()].sort((a, b) => b.value - a.value);
};

/** Per-ability totals, summed across every skill sharing an action id.
 *
 * The parser can emit more than one `SkillState` for one action — a generic id
 * reused across contexts, for instance — so mapping `skillBreakdown` 1:1 draws
 * the same ability twice with its damage split between the rows, and hands
 * React two children with the same key. Measured on log 544: "Link Attack" and
 * "Light Blast" each appeared twice. Same shape as `aggregateTargets`. */
export const aggregateAbilities = (skills: SkillState[], abilityLabel: (key: string) => string) => {
  const byKey = new Map<string, { key: string; label: string; value: number }>();
  for (const skill of skills) {
    const key = abilityKey(skill.actionType);
    const found = byKey.get(key);
    if (found) found.value += skill.totalDamage;
    else byKey.set(key, { key, label: abilityLabel(key), value: skill.totalDamage });
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
  sourceColor: (index: number) => string
) =>
  players
    .map((player) => ({
      key: `source:${player.index}`,
      label: sourceLabel(player.index),
      color: sourceColor(player.index),
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
        entries: aggregateAbilities(player.skillBreakdown, labels.ability),
      },
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(player.skillBreakdown, labels.enemy),
      },
    ];
  }

  if (level === "abilities") {
    const owner = players.find((candidate) => candidate.index === pins.source);
    // EVERY skill under the ability, not the first: the row above sums them, so
    // explaining it with one contributor describes a fraction of what it says.
    const skills = skillsForAbility(owner?.skillBreakdown ?? [], row.key.replace(/^skill:/, ""));
    if (skills.length === 0) return null;

    const hits = skills.reduce((sum, skill) => sum + skill.hits, 0);
    const damage = skills.reduce((sum, skill) => sum + skill.totalDamage, 0);
    // Extremes across the contributors — the smallest and largest single hit
    // any of them landed. A null means the log predates the field, not a zero.
    const mins = skills.map((skill) => skill.minDamage).filter((value): value is number => value !== null);
    const maxes = skills.map((skill) => skill.maxDamage).filter((value): value is number => value !== null);

    return [
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(skills, labels.enemy),
      },
      {
        headingKey: "ui.logs.hover-by-hits",
        color,
        entries: [
          { key: "count", label: labels.text("ui.logs.hover-count"), value: hits },
          { key: "min", label: labels.text("ui.skill-columns.min"), value: mins.length === 0 ? 0 : Math.min(...mins) },
          { key: "max", label: labels.text("ui.skill-columns.max"), value: maxes.length === 0 ? 0 : Math.max(...maxes) },
          {
            key: "avg",
            label: labels.text("ui.skill-columns.average"),
            value: hits === 0 ? 0 : Math.round(damage / hits),
          },
        ],
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
        entries: aggregateSources(players, actionKey, labels.source, labels.sourceColor),
      },
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets(skills, labels.enemy),
      },
    ];
  }

  return null;
};
