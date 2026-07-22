import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedSkillGroup, ComputedSkillState } from "@/types";
import { humanizeNumbers } from "@/utils";
import { useShallow } from "zustand/react/shallow";

/** The shared humanized value block a skill row or skill-group row renders. Both
 * {@link ComputedSkillState} and {@link ComputedSkillGroup} carry the fields it
 * reads, so `useSkillGroupRow` builds on this rather than duplicating it. */
export const useSkillRow = (skill: ComputedSkillState | ComputedSkillGroup) => {
  const { show_full_values } = useMeterSettingsStore(
    useShallow((state) => ({
      show_full_values: state.show_full_values,
    }))
  );

  const [totalDamage, totalDamageUnit] = humanizeNumbers(skill.totalDamage);
  const [minDmg, minDmgUnit] = humanizeNumbers(skill.minDamage || 0);
  const [maxDmg, maxDmgUnit] = humanizeNumbers(skill.maxDamage || 0);
  const rawAverageDmg = skill.hits === 0 ? 0 : skill.totalDamage / skill.hits;
  const [averageDmg, averageDmgUnit] = humanizeNumbers(rawAverageDmg);

  return {
    showFullValues: show_full_values,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
  };
};
