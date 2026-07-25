import { useShallow } from "zustand/react/shallow";

import SkillGroupMapping from "@/assets/skill-groups";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, ComputedSkillGroup, ComputedSkillState } from "@/types";
import { PRIMAL_BURST_GROUP, getSkillName, isPrimalBurstHit } from "@/utils";

/** Folds one more skill into an existing group row. */
const mergedGroup = (group: ComputedSkillGroup, skill: ComputedSkillState): ComputedSkillGroup => ({
  ...group,
  hits: group.hits + skill.hits,
  cappedHits: group.cappedHits + skill.cappedHits,
  cappableHits: group.cappableHits + skill.cappableHits,
  overcapBaseSum: group.overcapBaseSum + skill.overcapBaseSum,
  overcapCapSum: group.overcapCapSum + skill.overcapCapSum,
  percentage: group.percentage + skill.percentage,
  totalStunValue: group.totalStunValue + skill.totalStunValue,
  stunEligibleHits: (group.stunEligibleHits ?? 0) + (skill.stunEligibleHits ?? 0),
  maxStunValue: Math.max(group.maxStunValue, skill.maxStunValue),
  totalDamage: group.totalDamage + skill.totalDamage,
  minDamage: Math.min(group?.minDamage || 0, skill.minDamage || 0),
  maxDamage: Math.max(group?.maxDamage ?? Number.MIN_VALUE, skill.maxDamage || 0),
  skills: [...(group.skills || []), skill],
});

/** Opens a group row around its first skill. */
const newGroup = (group: string, skill: ComputedSkillState): ComputedSkillGroup => ({
  actionType: { Group: group },
  childCharacterType: skill.childCharacterType,
  hits: skill.hits,
  cappedHits: skill.cappedHits,
  cappableHits: skill.cappableHits,
  overcapBaseSum: skill.overcapBaseSum,
  overcapCapSum: skill.overcapCapSum,
  totalDamage: skill.totalDamage,
  minDamage: skill.minDamage,
  maxDamage: skill.maxDamage,
  percentage: skill.percentage,
  skills: [skill],
  maxStunValue: skill.maxStunValue,
  totalStunValue: skill.totalStunValue,
  stunEligibleHits: skill.stunEligibleHits ?? 0,
});

/** The index of an open group row, or -1. `childCharacterType` scopes a
 * character's own groups (a pet's skills group separately from its owner's);
 * the Primal Burst group spans three body classes, so it matches on the group
 * name alone. */
const findGroupRow = (
  rows: Array<ComputedSkillGroup | ComputedSkillState>,
  group: string,
  childCharacterType: ComputedSkillState["childCharacterType"] | null
) =>
  rows.findIndex((row) => {
    if (typeof row.actionType !== "object" || !Object.hasOwn(row.actionType, "Group")) return false;
    if ((row.actionType as { Group: string }).Group !== group) return false;

    return childCharacterType === null || row.childCharacterType === childCharacterType;
  });

export const useSkillBreakdown = (player: ComputedPlayerState) => {
  const { useCondensedSkills } = useMeterSettingsStore(
    useShallow((state) => ({
      useCondensedSkills: state.use_condensed_skills,
    }))
  );

  const totalDamage = player.skillBreakdown.reduce((acc, skill) => acc + skill.totalDamage, 0);
  const computedSkills = player.skillBreakdown.map<ComputedSkillState>((skill) => {
    return {
      // Guard the denominator: a stun-only breakdown (e.g. Perfect Guard before
      // any damage) would otherwise divide 0 by 0 and render "NaN%".
      percentage: totalDamage > 0 ? (skill.totalDamage / totalDamage) * 100 : 0,
      groupName: getSkillName(player.characterType, skill),
      ...skill,
    };
  });

  let skillsToShow: Array<ComputedSkillGroup | ComputedSkillState> = computedSkills;

  if (useCondensedSkills && typeof player.characterType == "string") {
    const skills: Array<ComputedSkillGroup | ComputedSkillGroup> = [];

    for (const skill of computedSkills) {
      // The three Primal Burst bodies are distinct classes sharing one action
      // id, so the per-character map (action ids under a character) can never
      // join them — they group on the body class instead.
      if (isPrimalBurstHit(skill)) {
        const index = findGroupRow(skills, PRIMAL_BURST_GROUP, null);

        if (index >= 0) {
          skills[index] = mergedGroup(skills[index] as ComputedSkillGroup, skill);
        } else {
          skills.push(newGroup(PRIMAL_BURST_GROUP, skill));
        }

        continue;
      }

      const skillGroupIndex = typeof skill.childCharacterType !== "string" ? -1 : skill.childCharacterType;
      const skillGroupMapping = SkillGroupMapping[skillGroupIndex] || {};

      if (typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "Normal")) {
        const actionType = skill.actionType as { Normal: number };
        let wasGroupedSkill = false;

        for (const group in skillGroupMapping) {
          const skillBelongsToGroup = skillGroupMapping[group].skills.includes(actionType.Normal);

          if (skillBelongsToGroup) {
            const skillGroupIndex = findGroupRow(skills, group, skill.childCharacterType);

            if (skillGroupIndex >= 0) {
              skills[skillGroupIndex] = mergedGroup(skills[skillGroupIndex] as ComputedSkillGroup, skill);
            } else {
              skills.push(newGroup(group, skill));
            }

            wasGroupedSkill = true;

            break;
          }
        }

        if (!wasGroupedSkill) {
          skills.push(skill);
        }
      } else {
        skills.push(skill);
      }
    }

    skillsToShow = skills;
  }

  skillsToShow.sort((a, b) => b.totalDamage - a.totalDamage);

  return {
    skills: skillsToShow,
  };
};
