import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedSkillGroup } from "@/types";
import { humanizeNumbers } from "@/utils";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

export const useSkillGroupRow = (group: ComputedSkillGroup) => {
  const { show_full_values, merge_supplementary } = useMeterSettingsStore(
    useShallow((state) => ({
      show_full_values: state.show_full_values,
      merge_supplementary: state.merge_supplementary,
    }))
  );

  const [expanded, setExpanded] = useState(false);

  const rawTotalDamage = group.totalDisplayDamage ?? group.totalDamage;
  const [totalDamage, totalDamageUnit] = humanizeNumbers(rawTotalDamage);
  const [minDmg, minDmgUnit] = humanizeNumbers(group.minDamage || 0);
  const [maxDmg, maxDmgUnit] = humanizeNumbers(group.maxDamage || 0);
  const rawAverageDmg = group.hits === 0 ? 0 : rawTotalDamage / group.hits;
  const [averageDmg, averageDmgUnit] = humanizeNumbers(rawAverageDmg);
  const [suppDmg, suppDmgUnit] = humanizeNumbers(group.suppDamage);
  const [echoDmg, echoDmgUnit] = humanizeNumbers(group.echoDamage);
  const ownPercentage = group.percentage - (group.suppPercentage ?? 0) - (group.echoPercentage ?? 0);

  const sortedSkills = (group.skills || []).sort((a, b) => b.totalDisplayDamage - a.totalDisplayDamage);

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
    expanded,
    setExpanded,
    sortedSkills,
  };
};
