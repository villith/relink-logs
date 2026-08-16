import { Text, Tooltip } from "@mantine/core";
import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Strip } from "@/components/ui/Strip";

import "./analysis.css";

export type QuestSummaryProps = {
  /** The pane's title — its `LogPicker`. A node rather than a name, because
   * what names this log is the control that also changes it. */
  title: ReactNode;
  /** 0-based Conflux room index, or null for an ordinary quest. The picker
   * names the quest from `questId`, which a Conflux run does not carry a
   * meaningful one for, so the room is stated here instead. */
  roomIndex: number | null;
  /** Copied in from another installation's logs.db. */
  imported: boolean;
};

/** The pane's header: which log it is reading, and the little the picker does
 * not already state.
 *
 * The picker carries the party, the quest name, the date, how long the run
 * took, the in-game time and the id (see `LogPicker`), so this row deliberately
 * repeats none of them. What is left is the Conflux room (no quest id for the
 * picker to name) and the imported badge — two marks ABOUT the log rather than
 * figures out of it. Restating a figure here is the change to resist: the two
 * would then disagree the moment either is reformatted, and the fight's own
 * total is already the first row of the table and the whole of the plot.
 *
 * Closing a comparison is NOT here either: it happens where opening one does,
 * at the actor bar's right edge (see `AnalysisView`).
 *
 * Analysis-only. `QuestHeader.tsx` is the same facts as a stacked label-value
 * list and is what Classic still draws — this does not replace it. */
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
