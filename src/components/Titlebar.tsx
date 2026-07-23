import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { ArrowCounterClockwise, Camera, ClipboardText, Minus, PushPinSimple } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { appWindow } from "@tauri-apps/api/window";
import { Fragment, useCallback } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import getVersion from "@/hooks/getVersion";
import { EncounterState, PlayerData, SortDirection, SortType } from "@/types";
import {
  exportFullEncounterToClipboard,
  exportScreenshotToClipboard,
  exportSimpleEncounterToClipboard,
  getBossHpTarget,
  humanizeNumbers,
  millisecondsToElapsedFormat,
} from "@/utils";

const BossHpStats = ({ encounterState }: { encounterState: EncounterState }) => {
  const boss = getBossHpTarget(encounterState.targets);
  if (!boss) return null;

  const currentHp = boss.currentHp as number;
  const maxHp = boss.maxHp as number;
  const percent = (currentHp / maxHp) * 100;
  const [current, currentUnit] = humanizeNumbers(currentHp);
  const [max, maxUnit] = humanizeNumbers(maxHp);

  return (
    <div data-tauri-drag-region className="encounter-bossHp item">
      HP <span className="stat-value">{percent.toFixed(1)}%</span>
      <span className="unit font-sm">
        {" "}
        (
        <span className="stat-value">
          {current}
          {currentUnit}
        </span>{" "}
        /{" "}
        <span className="stat-value">
          {max}
          {maxUnit}
        </span>
        )
      </span>
    </div>
  );
};

const TeamDamageStats = ({ encounterState }: { encounterState: EncounterState }) => {
  const { t } = useTranslation();
  const [teamDps, dpsUnit] = humanizeNumbers(encounterState.dps);
  const [totalTeamDmg, dmgUnit] = humanizeNumbers(encounterState.totalDamage);

  return (
    <Fragment>
      <div data-tauri-drag-region className="encounter-totalDamage item">
        <span className="stat-value">
          {totalTeamDmg}
          <span className="unit font-sm">{dmgUnit}</span>
        </span>
      </div>
      <div data-tauri-drag-region className="encounter-totalDps item">
        <span className="stat-value">
          {teamDps}
          <span className="unit font-sm">{t("ui.per-second", { unit: dpsUnit })}</span>
        </span>
      </div>
    </Fragment>
  );
};

const EncounterStatus = ({ encounterState, elapsedTime }: { encounterState: EncounterState; elapsedTime: number }) => {
  const { t } = useTranslation();
  if (encounterState.status === "Waiting") {
    return (
      <div data-tauri-drag-region className="encounter-status item">
        {t("ui.status-waiting")}
      </div>
    );
  } else if (encounterState.status === "InProgress") {
    return (
      <Fragment>
        <div data-tauri-drag-region className="encounter-elapsedTime item stat-value">
          {millisecondsToElapsedFormat(elapsedTime)}
        </div>
      </Fragment>
    );
  } else if (encounterState.status === "Stopped") {
    return (
      <Fragment>
        <div data-tauri-drag-region className="encounter-elapsedTime item stat-value">
          {millisecondsToElapsedFormat(encounterState.endTime - encounterState.startTime)}
        </div>
      </Fragment>
    );
  }
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
  const { version } = getVersion();

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
        {/* eslint-disable-next-line i18next/no-literal-string -- app name, never translated */}
        <div data-tauri-drag-region className="version">
          Relink Logs <span className="version-number">{version}</span>
        </div>
        {encounterState.totalDamage > 0 && <TeamDamageStats encounterState={encounterState} />}
        <BossHpStats encounterState={encounterState} />
      </div>
      <div data-tauri-drag-region className="titlebar-right">
        <EncounterStatus encounterState={encounterState} elapsedTime={elapsedTime} />
        <Menu shadow="md" trigger="hover" openDelay={100} closeDelay={400}>
          <Menu.Target>
            <ActionIcon aria-label="Clipboard" variant="transparent" color="light">
              <ClipboardText size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={handleSimpleEncounterCopy}>{t("ui.copy-to-clipboard-simple")}</Menu.Item>
            <Menu.Item onClick={handleFullEncounterCopy}>{t("ui.copy-to-clipboard-full")}</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip label={t("ui.pin-window")} color="dark">
          <div className="titlebar-button" id="titlebar-snapshot" onClick={onPin}>
            <PushPinSimple size={16} />
          </div>
        </Tooltip>
        <Tooltip label={t("ui.copy-screenshot-to-clipboard")} color="dark">
          <div className="titlebar-button" id="titlebar-snapshot" onClick={() => exportScreenshotToClipboard(".app")}>
            <Camera size={16} />
          </div>
        </Tooltip>
        <Tooltip label={t("ui.reset-session")} color="dark">
          <div className="titlebar-button" id="titlebar-reset" onClick={onResetSession}>
            <ArrowCounterClockwise size={16} />
          </div>
        </Tooltip>
        <div className="titlebar-button" id="titlebar-minimize" onClick={onMinimize}>
          <Minus size={16} />
        </div>
      </div>
    </div>
  );
};
