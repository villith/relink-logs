import { ComputedSkillGroup } from "@/types";
import { useState } from "react";
import { useSkillRow } from "./useSkillRow";

export const useSkillGroupRow = (group: ComputedSkillGroup) => {
  // The humanized damage/value fields are identical to a skill row's; only the
  // expand/collapse state and the sorted child list are group-specific.
  const base = useSkillRow(group);

  const [expanded, setExpanded] = useState(false);
  const sortedSkills = (group.skills || []).sort((a, b) => b.totalDamage - a.totalDamage);

  return {
    ...base,
    expanded,
    setExpanded,
    sortedSkills,
  };
};
