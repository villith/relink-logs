import { Box, NumberFormatter, Text, Tooltip } from "@mantine/core";
import { WarningCircle } from "@phosphor-icons/react";
import { t } from "i18next";

import type { EncounterState } from "@/types";
import { epochToLocalTime, hasQuestElapsedTime, millisecondsToElapsedFormat, toHash, translateQuestId } from "@/utils";

export type QuestHeaderProps = {
  encounter: EncounterState;
  questId: number | null;
  /** 0-based Conflux room index, or null for an ordinary quest. */
  roomIndex: number | null;
  questCompleted: boolean;
  /** The game's own quest timer in seconds, when it reported one. */
  questTimer: number | null;
  /** Copied in from another installation's logs.db. */
  imported: boolean;
};

/** What a log IS: which quest, when, how long, how much.
 *
 * Drawn by both the classic and analysis views — the same facts about a log
 * must not be stated two different ways depending on which view is open. */
export const QuestHeader = ({
  encounter,
  questId,
  roomIndex,
  questCompleted,
  questTimer,
  imported,
}: QuestHeaderProps) => (
  <Box>
    {roomIndex !== null && (
      <Box display="flex">
        <Text size="sm" fw={800}>
          {t("ui.logs.conflux-room", "Conflux Room")}:
        </Text>
        <Text size="sm" ml={4}>
          #{roomIndex + 1}
        </Text>
      </Box>
    )}
    {!!questId && roomIndex === null && (
      <Box display="flex">
        <Text size="sm" fw={800}>
          {t("ui.logs.quest-name")}:
        </Text>
        <Text size="sm" ml={4}>
          {translateQuestId(questId)} ({toHash(questId)}){" "}
        </Text>
      </Box>
    )}
    {!!questId && roomIndex === null && (
      <Box display="flex">
        <Text size="sm" fw={800}>
          {t("ui.logs.quest-status")}:
        </Text>
        <Text size="sm" fs="italic" ml={4}>
          {questCompleted ? "✅" : "❌"}
        </Text>
      </Box>
    )}
    <Box display="flex">
      <Text size="sm" fw={800}>
        {t("ui.logs.date")}:
      </Text>
      <Text size="sm" fs="italic" ml={4}>
        {epochToLocalTime(encounter.startTime)}
      </Text>
      {imported && (
        <Tooltip label={t("ui.logs.imported-tooltip")} multiline w={280}>
          <WarningCircle
            size={20}
            color="var(--mantine-color-yellow-6)"
            style={{ marginLeft: "auto" }}
            aria-label={t("ui.imported-badge")}
          />
        </Tooltip>
      )}
    </Box>
    <Box display="flex">
      <Text size="sm" fw={800}>
        {t("ui.logs.duration")}:
      </Text>
      <Text size="sm" fs="italic" ml={4}>
        {millisecondsToElapsedFormat(encounter.endTime - encounter.startTime)}
      </Text>
    </Box>
    {/* The game's own quest timer, shown whenever it reported one. Kept
        distinct from Duration above: Duration is wall-clock time between
        the first and last hit (what DPS is measured over), while this is
        the clear time the result screen reports, which also covers the
        run up to the boss. */}
    {hasQuestElapsedTime(questTimer) ? (
      <Box display="flex">
        <Text size="sm" fw={800}>
          {t("ui.logs.quest-elapsed-time")}:
        </Text>
        <Text size="sm" fs="italic" ml={4}>
          {millisecondsToElapsedFormat(questTimer * 1000)}
        </Text>
      </Box>
    ) : null}
    <Box display="flex">
      <Text size="sm" fw={800}>
        {t("ui.logs.total-damage")}:
      </Text>
      <Text size="sm" fs="italic" ml={4}>
        <NumberFormatter thousandSeparator value={encounter.totalDamage} />
      </Text>
    </Box>
  </Box>
);
