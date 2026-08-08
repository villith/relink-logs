import { Box, Text, Tooltip } from "@mantine/core";
import { WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { EncounterState } from "@/types";
import {
  epochToLocalTime,
  hasQuestElapsedTime,
  humanizeNumbers,
  millisecondsToElapsedFormat,
  translateQuestId,
} from "@/utils";

import "./analysis.css";

export type QuestSummaryProps = {
  encounter: EncounterState;
  questId: number | null;
  /** 0-based Conflux room index, or null for an ordinary quest. */
  roomIndex: number | null;
  questCompleted: boolean;
  /** The game's own quest timer in seconds, when it reported one. */
  questTimer: number | null;
  /** Copied in from another installation's logs.db. */
  imported: boolean;
  /** The log's database id, shown so a specific log can be referred to (bug
   * reports, the diag examples' `--id`). Null when the route id is not a
   * number, which never happens off a real logs link. */
  logId: number | null;
};

/** What a log is, on one line: which quest, cleared or not, how long, when, how
 * much.
 *
 * Analysis-only. `QuestHeader.tsx` is the same facts as a stacked label-value
 * list and is what Classic still draws — this does not replace it. */
export const QuestSummary = ({
  encounter,
  questId,
  roomIndex,
  questCompleted,
  questTimer,
  imported,
  logId,
}: QuestSummaryProps) => {
  const { t } = useTranslation();
  const [total, totalSuffix] = humanizeNumbers(encounter.totalDamage);

  // Duration is wall-clock between the first and last hit, which is what DPS is
  // measured over. The quest timer is the result screen's clear time and also
  // covers the run up to the boss, so the two are stated separately.
  const duration = millisecondsToElapsedFormat(encounter.endTime - encounter.startTime);
  const timer = hasQuestElapsedTime(questTimer)
    ? ` · ${t("ui.logs.quest-elapsed-time")} ${millisecondsToElapsedFormat(questTimer * 1000)}`
    : "";

  const name =
    roomIndex !== null
      ? `${t("ui.logs.conflux-room", "Conflux Room")} #${roomIndex + 1}`
      : questId
        ? translateQuestId(questId)
        : "";

  return (
    <Box
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 11,
        padding: "11px 16px 10px",
        borderBottom: "1px solid var(--an-line)",
      }}
    >
      {/* The quest name truncates so the metadata beside it never has to wrap:
          at a 620px viewport the block grew 48px -> 71px and "Total Damage"
          broke onto two lines. */}
      <Text
        style={{
          fontWeight: 700,
          fontSize: "var(--an-fs-xl)",
          letterSpacing: "-0.015em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {name}
      </Text>
      {roomIndex === null && !!questId && (
        <Text style={{ fontSize: "var(--an-fs-xs)" }} c={questCompleted ? "teal.4" : "red.5"}>
          {questCompleted ? t("ui.logs.quest-cleared") : t("ui.logs.quest-failed")}
        </Text>
      )}
      <Text
        className="analysis-num"
        style={{ fontSize: "var(--an-fs-sm)", color: "var(--an-ink-3)", whiteSpace: "nowrap" }}
      >
        {duration}
        {timer} · {epochToLocalTime(encounter.startTime)}
        {/* eslint-disable-next-line i18next/no-literal-string -- a "#" plus a
            database id is notation, not prose */}
        {logId !== null && ` · #${logId}`}
      </Text>
      {imported && (
        <Tooltip label={t("ui.logs.imported-tooltip")} multiline w={280}>
          <WarningCircle size={18} color="var(--mantine-color-yellow-6)" aria-label={t("ui.imported-badge")} />
        </Tooltip>
      )}
      <Text className="analysis-label" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
        {t("ui.logs.total-damage")}
      </Text>
      <Text className="analysis-num" style={{ fontWeight: 700, fontSize: "var(--an-fs-2xl)" }}>
        {total}
        {totalSuffix}
      </Text>
    </Box>
  );
};
