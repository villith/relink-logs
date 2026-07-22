import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  CharacterType,
  ComputedPlayerState,
  ComputedSkillGroup,
  ComputedSkillState,
  SkillColumns,
  visibleColumns,
} from "@/types";

import { getSkillName } from "@/utils";
import { SkillGroupRow } from "./SkillGroupRow";
import { SkillRow } from "./SkillRow";
import { useSkillBreakdown } from "./useSkillBreakdown";

export type SkillBreakdownProps = {
  player: ComputedPlayerState;
  color: string;
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};

const renderSkillRow = (
  characterType: CharacterType,
  skillData: ComputedSkillState | ComputedSkillGroup,
  color: string,
  columns: SkillColumns[],
  durationSeconds: number,
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
        durationSeconds={durationSeconds}
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
        durationSeconds={durationSeconds}
        live={live}
      />
    );
  }
};

export const SkillBreakdown = ({ player, color, durationSeconds = 0, live }: SkillBreakdownProps) => {
  const { t } = useTranslation();
  const { skills } = useSkillBreakdown(player);
  const { overlaySkillColumns, logsSkillColumns } = useMeterSettingsStore(
    useShallow((state) => ({
      overlaySkillColumns: state.overlay_skill_columns,
      logsSkillColumns: state.logs_skill_columns,
    }))
  );

  // The overlay honours the user's overlay columns; the logs view honours the
  // (separately-defaulted) logs columns. Memoized: the source lists are stable
  // store refs, so this only recomputes when the user edits columns.
  const columns = useMemo(
    () => visibleColumns(live ? overlaySkillColumns : logsSkillColumns),
    [live, overlaySkillColumns, logsSkillColumns]
  );

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
            {skills.map((skill) => renderSkillRow(player.characterType, skill, color, columns, durationSeconds, live))}
          </tbody>
        </table>
      </td>
    </tr>
  );
};
