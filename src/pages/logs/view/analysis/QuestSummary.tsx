import { Group, Text, Tooltip } from "@mantine/core";
import { CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Strip } from "@/components/ui/Strip";

import "./analysis.css";

export type QuestSummaryProps = {
  title: ReactNode;
  roomIndex: number | null;
  imported: boolean;
  /** null hides the indicator: no quest on this log, a Conflux room, or not
   * yet loaded — the caller collapses all three into one null. */
  questCompleted: boolean | null;
};

export const QuestSummary = ({ title, roomIndex, imported, questCompleted }: QuestSummaryProps) => {
  const { t } = useTranslation();

  return (
    <Strip className="gap-2.5 py-1.5">
      {title}
      {roomIndex !== null && (
        <Text className="whitespace-nowrap text-lg font-semibold">
          {/* eslint-disable-next-line i18next/no-literal-string -- "#" plus a room number is notation */}
          {t("ui.logs.conflux-room", "Conflux Room")} #{roomIndex + 1}
        </Text>
      )}
      {questCompleted !== null && (
        <Group gap={4} wrap="nowrap">
          {questCompleted ? (
            <CheckCircle size={16} color="var(--mantine-color-green-6)" />
          ) : (
            <XCircle size={16} color="var(--mantine-color-red-6)" />
          )}
          <Text className="whitespace-nowrap text-sm">
            {questCompleted ? t("ui.logs.quest-cleared") : t("ui.logs.quest-failed")}
          </Text>
        </Group>
      )}
      {imported && (
        <Tooltip label={t("ui.logs.imported-tooltip")} multiline w={280}>
          <WarningCircle size={18} color="var(--mantine-color-yellow-6)" aria-label={t("ui.imported-badge")} />
        </Tooltip>
      )}
    </Strip>
  );
};
