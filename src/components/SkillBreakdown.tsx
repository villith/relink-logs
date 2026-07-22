import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  CharacterType,
  ComputedPlayerState,
  ComputedSkillGroup,
  ComputedSkillState,
  DEFAULT_SKILL_COLUMNS,
  SkillColumns,
} from "@/types";

import { getSkillName } from "@/utils";
import { SkillGroupRow } from "./SkillGroupRow";
import { SkillRow } from "./SkillRow";
import { useSkillBreakdown } from "./useSkillBreakdown";

export type SkillBreakdownProps = {
  player: ComputedPlayerState;
  color: string;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

const renderSkillRow = (
  characterType: CharacterType,
  skillData: ComputedSkillState | ComputedSkillGroup,
  color: string,
  columns: SkillColumns[],
  live?: boolean
) => {
  const isSkillGroup = typeof skillData.actionType === "object" && Object.hasOwn(skillData.actionType, "Group");

  if (isSkillGroup) {
    const skillGroup = skillData as ComputedSkillGroup;

    return (
      <SkillGroupRow
        key={`${skillGroup.childCharacterType}-${getSkillName(characterType, skillGroup)}`}
        characterType={characterType}
        group={skillGroup}
        color={color}
        columns={columns}
        live={live}
      />
    );
  } else {
    const skill = skillData as ComputedSkillState;

    return (
      <SkillRow
        key={`${skill.childCharacterType}-${getSkillName(characterType, skill)}`}
        characterType={characterType}
        skill={skill}
        color={color}
        columns={columns}
        live={live}
      />
    );
  }
};

export const SkillBreakdown = ({ player, color, live }: SkillBreakdownProps) => {
  const { t } = useTranslation();
  const { skills } = useSkillBreakdown(player);
  const { overlaySkillColumns } = useMeterSettingsStore(
    useShallow((state) => ({ overlaySkillColumns: state.overlay_skill_columns }))
  );

  // The overlay honours the user's chosen columns; the logs view always shows
  // the full set.
  const columns = live ? overlaySkillColumns : DEFAULT_SKILL_COLUMNS;

  return (
    <tr className="skill-table">
      <td colSpan={100}>
        <table className="table w-full">
          <thead className="header transparent-bg">
            <tr>
              <th className="header-name">Skill</th>
              {columns.map((column) => (
                <th key={column} className="header-column text-center">
                  {t(`ui.skill-columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="transparent-bg">
            {skills.map((skill) => renderSkillRow(player.characterType, skill, color, columns, live))}
          </tbody>
        </table>
      </td>
    </tr>
  );
};
