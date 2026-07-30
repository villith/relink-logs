import { useShallow } from "zustand/react/shallow";

import SkillGroupMapping from "@/assets/skill-groups";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, ComputedSkillGroup, ComputedSkillState, CustomSkillGroup } from "@/types";
import { PRIMAL_BURST_GROUP, getSkillName, isPrimalBurstHit, isSkillGroup } from "@/utils";

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
    if (!isSkillGroup(row) || row.actionType.Group !== group) return false;

    return childCharacterType === null || row.childCharacterType === childCharacterType;
  });

/** Merges `skill` into its group row, opening the row if this is its first skill. */
const upsertGroup = (
  rows: Array<ComputedSkillGroup>,
  group: string,
  skill: ComputedSkillState,
  childCharacterType: ComputedSkillState["childCharacterType"] | null
) => {
  const index = findGroupRow(rows, group, childCharacterType);

  if (index >= 0) {
    rows[index] = mergedGroup(rows[index], skill);
  } else {
    rows.push(newGroup(group, skill));
  }
};

/** Finds the first custom rule that claims this Normal action id, or null. */
const findCustomRule = (customGroups: CustomSkillGroup[], actionId: number): CustomSkillGroup | null => {
  for (const rule of customGroups) {
    if (rule.skillIds.includes(actionId)) return rule;
  }
  return null;
};

export const useSkillBreakdown = (player: ComputedPlayerState) => {
  const { useCondensedSkills, customSkillGroups, disabledPresetGroups } = useMeterSettingsStore(
    useShallow((state) => ({
      useCondensedSkills: state.use_condensed_skills,
      customSkillGroups: state.custom_skill_groups,
      disabledPresetGroups: state.disabled_preset_groups ?? [],
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
    const charKey = player.characterType;
    const skills: Array<ComputedSkillGroup | ComputedSkillState> = [];

    // Filter active custom rules for this character
    const activeCustomRules = customSkillGroups.filter((r) => r.characterType === charKey && r.enabled !== false);

    // Build a set of action IDs claimed by active custom rules for this character
    const customClaimedIds = new Set<number>();
    for (const rule of activeCustomRules) {
      for (const id of rule.skillIds) customClaimedIds.add(id);
    }

    for (const skill of computedSkills) {
      // The three Primal Burst bodies are distinct classes sharing one action
      // id, so the per-character map (action ids under a character) can never
      // join them — they group on the body class instead.
      if (isPrimalBurstHit(skill)) {
        upsertGroup(skills, PRIMAL_BURST_GROUP, skill, null);
        continue;
      }

      const skillGroupIndex = typeof skill.childCharacterType !== "string" ? -1 : skill.childCharacterType;
      const skillGroupMapping = SkillGroupMapping[skillGroupIndex] || {};

      if (typeof skill.actionType == "object" && Object.hasOwn(skill.actionType, "Normal")) {
        const actionType = skill.actionType as { Normal: number };
        const actionId = actionType.Normal;

        // 1. Active custom rules take priority over the static mapping.
        if (customClaimedIds.has(actionId)) {
          const rule = findCustomRule(activeCustomRules, actionId);
          if (rule) {
            // The group key encodes the display name so getSkillName can
            // recover it without accessing the store (see utils.ts).
            upsertGroup(skills, `custom::${rule.name}`, skill, skill.childCharacterType);
            continue;
          }
        }

        // 2. Fall back to the static skill-groups.json mapping (unless disabled).
        let wasGroupedSkill = false;

        for (const group in skillGroupMapping) {
          const presetIdentifier = `${skillGroupIndex}::${group}`;
          if (disabledPresetGroups.includes(presetIdentifier)) {
            continue;
          }

          const skillBelongsToGroup = skillGroupMapping[group].skills.includes(actionId);

          if (skillBelongsToGroup) {
            upsertGroup(skills, group, skill, skill.childCharacterType);
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
