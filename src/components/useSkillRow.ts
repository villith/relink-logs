import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedSkillState } from "@/types";
import { humanizeNumbers } from "@/utils";
import { useShallow } from "zustand/react/shallow";

export const useSkillRow = (skill: ComputedSkillState) => {
  const { show_full_values, merge_supplementary } = useMeterSettingsStore(
    useShallow((state) => ({
      show_full_values: state.show_full_values,
      merge_supplementary: state.merge_supplementary,
    }))
  );

  const rawTotalDamage = skill.totalDisplayDamage ?? skill.totalDamage;
  const [totalDamage, totalDamageUnit] = humanizeNumbers(rawTotalDamage);
  const [minDmg, minDmgUnit] = humanizeNumbers(skill.minDamage || 0);
  const [maxDmg, maxDmgUnit] = humanizeNumbers(skill.maxDamage || 0);
  const rawAverageDmg = skill.hits === 0 ? 0 : rawTotalDamage / skill.hits;
  const [averageDmg, averageDmgUnit] = humanizeNumbers(rawAverageDmg);
  const [suppDmg, suppDmgUnit] = humanizeNumbers(skill.suppDamage);
  const [echoDmg, echoDmgUnit] = humanizeNumbers(skill.echoDamage);
  const ownPercentage = skill.percentage - (skill.suppPercentage ?? 0) - (skill.echoPercentage ?? 0);

  return {
    showFullValues: show_full_values,
    mergeSupplementary: merge_supplementary,
    rawTotalDamage,
    totalDamage,
    totalDamageUnit,
    minDmg,
    minDmgUnit,
    maxDmg,
    maxDmgUnit,
    rawAverageDmg,
    averageDmg,
    averageDmgUnit,
    suppDmg,
    suppDmgUnit,
    echoDmg,
    echoDmgUnit,
    ownPercentage,
  };
};
