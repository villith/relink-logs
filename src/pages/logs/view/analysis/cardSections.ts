import type { ComputedPlayerState, EnemyType, SkillState } from "@/types";

import { abilityKey } from "../abilityKey";
import type { RowLevel } from "../deriveRows";
import type { MetricRow } from "../metrics/types";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";

/** Name lookups the view injects, so this stays a pure function: skill and
 * enemy names need i18n, and player names need the settings store. */
export type SectionLabels = {
  ability: (key: string) => string;
  enemy: (type: EnemyType) => string;
  text: (key: string) => string;
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

const TARGET_COLOR = "var(--mantine-color-red-6)";

/** The hover card's sections for one row, or null when the row has nothing to
 * decompose.
 *
 * A player is explained by ability and by target. An ability is explained by
 * target and by how its hits landed — but never by source, because
 * `rowLevelFor` only reaches the abilities level once a source is pinned, so
 * that section would always hold a single row at 100%. A hit is already the
 * most specific thing there is. */
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
    const skill = owner?.skillBreakdown.find((candidate) => `skill:${abilityKey(candidate.actionType)}` === row.key);
    if (!skill) return null;

    return [
      {
        headingKey: "ui.logs.hover-by-target",
        color: TARGET_COLOR,
        entries: aggregateTargets([skill], labels.enemy),
      },
      {
        headingKey: "ui.logs.hover-by-hits",
        color,
        entries: [
          { key: "count", label: labels.text("ui.logs.hover-count"), value: skill.hits },
          { key: "min", label: labels.text("ui.skill-columns.min"), value: skill.minDamage ?? 0 },
          { key: "max", label: labels.text("ui.skill-columns.max"), value: skill.maxDamage ?? 0 },
          {
            key: "avg",
            label: labels.text("ui.skill-columns.average"),
            value: skill.hits === 0 ? 0 : Math.round(skill.totalDamage / skill.hits),
          },
        ],
      },
    ];
  }

  return null;
};
