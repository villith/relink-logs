import { invoke } from "@tauri-apps/api";
import { appWindow } from "@tauri-apps/api/window";
import { useCallback } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import { HOOK_LABEL_KEY, HOOK_TONE_CLASS } from "@/hookState";
import { useAppVersion } from "@/hooks/useAppVersion";
import type { TemplateTokens } from "@/labelTemplate";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { EncounterState, PlayerData, SortDirection, SortType } from "@/types";
import { useHookStatus } from "@/useHookStatus";
import {
  exportFullEncounterToClipboard,
  exportScreenshotToClipboard,
  exportSimpleEncounterToClipboard,
  getBossHpTarget,
  humanizeNumbers,
  millisecondsToElapsedFormat,
} from "@/utils";
import { HeaderSegments } from "./HeaderSegments";
import { TitlebarButtons } from "./TitlebarButtons";

/** Every token an overlay header segment may use. Exported for the settings
 * editor, which lists them and flags anything else as a typo. */
export const HEADER_TOKENS = [
  "app",
  "version",
  "damage",
  "dps",
  "hpPercent",
  "hpCurrent",
  "hpMax",
  "time",
  "status",
] as const;

/**
 * Header token values for the current encounter.
 *
 * An absent value is the empty string, never a placeholder: empty is what
 * collapses its whole segment, which is how team damage stays hidden until
 * damage lands and boss HP until a target reports one.
 */
const useHeaderTokens = (
  encounterState: EncounterState,
  elapsedTime: number,
  version: string
): { tokens: TemplateTokens; toneClass: string } => {
  const { t } = useTranslation();
  const hook = useHookStatus();
  const boss = getBossHpTarget(encounterState.targets);

  // An unknown hook (status not read yet) reads as the disconnected "No game found".
  const state = hook?.state ?? "disconnected";

  const hasDamage = encounterState.totalDamage > 0;
  const [totalDamage, damageUnit] = humanizeNumbers(encounterState.totalDamage);
  const [dps, dpsUnit] = humanizeNumbers(encounterState.dps);

  // During a fight the running timer; a finished fight its frozen final
  // duration; idle, nothing at all — so a {time} segment disappears rather than
  // showing 00:00.
  let time = "";
  if (encounterState.status === "InProgress") {
    time = millisecondsToElapsedFormat(elapsedTime);
  } else if (hasDamage) {
    time = millisecondsToElapsedFormat(encounterState.endTime - encounterState.startTime);
  }

  let hpPercent = "";
  let hpCurrent = "";
  let hpMax = "";
  if (boss && boss.currentHp != null && boss.maxHp != null) {
    const [current, currentUnit] = humanizeNumbers(boss.currentHp);
    const [max, maxUnit] = humanizeNumbers(boss.maxHp);
    hpPercent = `${((boss.currentHp / boss.maxHp) * 100).toFixed(1)}%`;
    hpCurrent = `${current}${currentUnit}`;
    hpMax = `${max}${maxUnit}`;
  }

  return {
    tokens: {
      // eslint-disable-next-line i18next/no-literal-string -- app name, never translated
      app: "Relink Logs",
      version,
      damage: hasDamage ? `${totalDamage}${damageUnit}` : "",
      dps: hasDamage ? `${dps}${dpsUnit}` : "",
      hpPercent,
      hpCurrent,
      hpMax,
      time,
      // The one token that always renders something: the timer when there is a
      // fight to time, otherwise how the hook is doing.
      status: time || t(HOOK_LABEL_KEY[state]),
    },
    toneClass: HOOK_TONE_CLASS[state],
  };
};

export const Titlebar = ({
  encounterState,
  partyData,
  elapsedTime,
  sortType,
  sortDirection,
}: {
  encounterState: EncounterState;
  partyData: Array<PlayerData | null>;
  elapsedTime: number;
  sortType: SortType;
  sortDirection: SortDirection;
}) => {
  const { t } = useTranslation();
  const version = useAppVersion();
  const header_segments = useMeterSettingsStore((state) => state.header_segments);
  const header_buttons = useMeterSettingsStore((state) => state.header_buttons);
  const { tokens, toneClass } = useHeaderTokens(encounterState, elapsedTime, version);

  const onMinimize = () => {
    appWindow.minimize();
  };
  const onPin = () => {
    invoke("toggle_always_on_top");
  };
  const onResetSession = () => {
    invoke("reset_encounter");
    toast.success(t("ui.session-reset"));
  };

  const handleSimpleEncounterCopy = useCallback(() => {
    exportSimpleEncounterToClipboard(sortType, sortDirection, encounterState, partyData);
  }, [encounterState]);

  const handleFullEncounterCopy = useCallback(() => {
    exportFullEncounterToClipboard(sortType, sortDirection, encounterState, partyData);
  }, [encounterState]);

  return (
    <div data-tauri-drag-region className="titlebar transparent-bg font-sm">
      <div data-tauri-drag-region className="titlebar-left">
        <HeaderSegments segments={header_segments} side="left" tokens={tokens} toneClass={toneClass} />
      </div>
      <div data-tauri-drag-region className="titlebar-right">
        <HeaderSegments segments={header_segments} side="right" tokens={tokens} toneClass={toneClass} />
        <TitlebarButtons
          visible={header_buttons}
          actions={{
            onCopySimple: handleSimpleEncounterCopy,
            onCopyFull: handleFullEncounterCopy,
            onPin,
            onScreenshot: () => exportScreenshotToClipboard(".app"),
            onReset: onResetSession,
            onMinimize,
          }}
        />
      </div>
    </div>
  );
};
