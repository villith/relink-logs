import { skillGroupFor } from "@/components/skillGrouping";
import type { AbilityChartSeries, CharacterType, EnemyType, SkillState, TargetChartSeries } from "@/types";

import { abilityKey } from "../abilityKey";
import { targetLabelKey } from "../../../../utils";

/** One band of the drill-down chart, ready to plot: a stable series key, the
 * name the legend shows, and one value per bucket. */
export type DrillSeries = { key: string; label: string; values: number[] };

/** Elementwise sum into `into`, growing it if `values` is longer. */
const addInto = (into: number[], values: number[]) => {
  for (let bucket = 0; bucket < values.length; bucket++) {
    into[bucket] = (into[bucket] ?? 0) + values[bucket];
  }
};

const byTotalDescending = (a: DrillSeries, b: DrillSeries) => {
  const total = (series: DrillSeries) => series.values.reduce((sum, value) => sum + value, 0);
  return total(b) - total(a);
};

/** The pinned player's per-ability bands, folded into skill groups.
 *
 * Always condensed, whatever `use_condensed_skills` says: that setting governs
 * Classic's table rows, and a 27-band stack is unreadable regardless of it. The
 * fold is a sum per bucket, so it is lossless — which is why the backend sends
 * raw action ids and the grouping happens here, where the one grouping rule
 * already lives.
 *
 * `skillName` is injected rather than imported so this stays pure; callers pass
 * `getSkillName`, which resolves a group through
 * `skills.<character>.skill-groups.<group>` — the legend must never read a raw
 * group key like "power-raise". */
export const foldAbilityChart = (
  series: AbilityChartSeries[],
  characterType: CharacterType,
  skillName: (characterType: CharacterType, skill: SkillState) => string
): DrillSeries[] => {
  const byKey = new Map<string, DrillSeries>();

  for (const band of series) {
    const skill = band as unknown as SkillState;
    const group = skillGroupFor(skill);

    // The child is part of the key even for a group: a pet's group is not its
    // owner's. A group spanning classes (Primal Burst) carries a null child and
    // so collapses to one band, which is the point of it.
    const key =
      group === null
        ? `skill:${abilityKey(band.actionType)}:${JSON.stringify(band.childCharacterType)}`
        : `group:${group.group}:${JSON.stringify(group.childCharacterType)}`;

    const found = byKey.get(key);
    if (found) {
      addInto(found.values, band.values);
      continue;
    }

    byKey.set(key, {
      key,
      label:
        group === null
          ? skillName(characterType, skill)
          : skillName(characterType, {
              ...skill,
              actionType: { Group: group.group },
            } as SkillState),
      values: [...band.values],
    });
  }

  return [...byKey.values()].sort(byTotalDescending);
};

/** The pinned ability's per-spawn bands.
 *
 * No folding: the backend already emits one band per spawn segment, and the
 * point of keying by spawn is that a band lines up with the target pin and the
 * enemy-HP chart. `label` is the shared target-labelling rule, so the same enemy
 * cannot read one way here and another in the dropdown. */
export const foldTargetChart = (
  series: TargetChartSeries[],
  label: (enemyType: EnemyType, instance: number) => string
): DrillSeries[] =>
  byTotalDescending(
    series.map((band) => ({
      // The type, never its rendered name: two type hashes can share a display
      // name, and a name-keyed series would overwrite the other's line.
      key: `target:${targetLabelKey(band.enemyType, band.instance)}`,
      label: label(band.enemyType, band.instance),
      values: [...band.values],
    }))
  );
