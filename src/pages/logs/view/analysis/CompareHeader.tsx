import { ActionIcon, Button, Group } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { LogSummary } from "@/types";

import { LogPicker } from "./LogPicker";

export type CompareHeaderProps = {
  logs: LogSummary[];
  /** One id per pane, pane 0 first. */
  paneLogIds: number[];
  onAddPane: () => void;
  onRemovePane: (paneIndex: number) => void;
  onChangePaneLog: (paneIndex: number, logId: number) => void;
};

/** Which logs this view is reading, and the controls that open and close a
 * comparison.
 *
 * Pane 0 is the log in the path and has no remove control — closing it means
 * leaving the page. Every other pane carries one. The header renders whatever
 * length the pane list is; the single **+ Compare** button is what keeps the
 * shipped UI at two (see the spec's "out of scope"). */
export const CompareHeader = ({ logs, paneLogIds, onAddPane, onRemovePane, onChangePaneLog }: CompareHeaderProps) => {
  const { t } = useTranslation();

  return (
    <Group gap={10} px={16} py={10} wrap="wrap">
      {paneLogIds.map((logId, paneIndex) => (
        // Keyed by INDEX, like the panes themselves: two panes may carry one
        // log, so a log id is not a key.
        <Group key={paneIndex} gap={4} wrap="nowrap">
          <LogPicker logs={logs} value={logId} onChange={(next) => onChangePaneLog(paneIndex, next)} />
          {paneIndex > 0 && (
            <ActionIcon
              variant="subtle"
              aria-label={t("ui.logs.compare-remove")}
              onClick={() => onRemovePane(paneIndex)}
            >
              <X size={16} />
            </ActionIcon>
          )}
        </Group>
      ))}
      {paneLogIds.length === 1 && (
        <Button variant="default" size="xs" onClick={onAddPane}>
          {t("ui.logs.compare-add")}
        </Button>
      )}
    </Group>
  );
};
