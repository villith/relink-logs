import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore, type BarFillMode } from "@/stores/useMeterSettingsStore";
import {
  CharacterType,
  ComputedPlayerState,
  ComputedSkillGroup,
  ComputedSkillState,
  SkillColumns,
  visibleColumns,
} from "@/types";

import { getSkillName, isSkillGroup, meterGridTemplate } from "@/utils";
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
  maxPercentage: number,
  fillMode: BarFillMode,
  live?: boolean
) => {
  if (isSkillGroup(skillData)) {
    const skillGroup = skillData;

    return (
      <SkillGroupRow
        key={`${skillGroup.childCharacterType}-${getSkillName(characterType, skillGroup)}`}
        characterType={characterType}
        group={skillGroup}
        color={color}
        columns={columns}
        durationSeconds={durationSeconds}
        maxPercentage={maxPercentage}
        fillMode={fillMode}
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
        maxPercentage={maxPercentage}
        fillMode={fillMode}
        live={live}
      />
    );
  }
};

export const SkillBreakdown = ({ player, color, durationSeconds = 0, live }: SkillBreakdownProps) => {
  const { t } = useTranslation();
  const { skills } = useSkillBreakdown(player);
  const { overlaySkillColumns, logsSkillColumns, barFillMode } = useMeterSettingsStore(
    useShallow((state) => ({
      overlaySkillColumns: state.overlay_skill_columns,
      logsSkillColumns: state.logs_skill_columns,
      barFillMode: state.bar_fill_mode,
    }))
  );

  // One max for the whole breakdown, taken over the top-level rows. Nested rows
  // reuse it: a child's damage is always <= its group's, so a child bar can
  // never overrun the parent bar it sits under.
  const maxPercentage = skills.reduce((max, skill) => Math.max(max, skill.percentage || 0), 0);

  // The overlay honours the user's overlay columns; the logs view honours the
  // (separately-defaulted) logs columns. Memoized: the source lists are stable
  // store refs, so this only recomputes when the user edits columns.
  const columns = useMemo(
    () => visibleColumns(live ? overlaySkillColumns : logsSkillColumns),
    [live, overlaySkillColumns, logsSkillColumns]
  );

  return (
    // No caret track here — a group row draws its own caret inside the name
    // cell rather than in a column of its own.
    <div
      role="table"
      className="table w-full skill-table"
      style={
        {
          "--meter-grid": meterGridTemplate(columns.length),
        } as CSSProperties
      }
    >
      <div className="header transparent-bg" role="rowgroup">
        <div className="meter-row" role="row">
          <div className="header-name" role="columnheader">
            {t("ui.skill-columns.skill")}
          </div>
          {columns.map((column) => (
            <div key={column} role="columnheader" className="header-column text-center">
              {t(`ui.skill-columns.${column}`)}
            </div>
          ))}
        </div>
      </div>
      <div className="table-body transparent-bg" role="rowgroup">
        {skills.map((skill) =>
          renderSkillRow(player.characterType, skill, color, columns, durationSeconds, maxPercentage, barFillMode, live)
        )}
      </div>
    </div>
  );
};
