import { Text, Tooltip } from "@mantine/core";
import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Strip } from "@/components/ui/Strip";

import "./analysis.css";

export type QuestSummaryProps = {
  title: ReactNode;
  roomIndex: number | null;
  imported: boolean;
};

export const QuestSummary = ({ title, roomIndex, imported }: QuestSummaryProps) => {
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
      {imported && (
        <Tooltip label={t("ui.logs.imported-tooltip")} multiline w={280}>
          <WarningCircle size={18} color="var(--mantine-color-yellow-6)" aria-label={t("ui.imported-badge")} />
        </Tooltip>
      )}
    </Strip>
  );
};
