import { Button, Group, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";
import { ACTIONABLE_HOOK_STATES, HOOK_DOT_COLOR, HOOK_LABEL_KEY } from "@/hookState";
import { useEncounterStore } from "@/stores/useEncounterStore";
import { useHookStatus } from "@/useHookStatus";

/** Hook connection/version status + actions, shown in the logs header. */
export default function HookStatusBadge() {
  const { t } = useTranslation();
  const hook = useHookStatus();
  const [busy, setBusy] = useState(false);

  if (!hook) return null;

  const runRefresh = async () => {
    setBusy(true);
    try {
      await invoke("refresh_hook");
      toast.success(t("ui.hook-status.refreshed"));
    } catch (e) {
      const msg = backendErrorMessage(t, "hook", String(e)) ?? String(e);
      toast.error(t("ui.hook-status.refresh-failed", { error: msg }));
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = () => {
    // Refresh tears the hook down; warn if an encounter is live.
    const inProgress = useEncounterStore.getState().encounterState?.status === "InProgress";
    if (inProgress) {
      modals.openConfirmModal({
        centered: true,
        title: t("ui.hook-status.refresh"),
        children: <Text size="sm">{t("ui.hook-status.refresh-encounter-warning")}</Text>,
        labels: { confirm: t("ui.hook-status.refresh"), cancel: t("ui.update-skip") },
        onConfirm: runRefresh,
      });
    } else {
      runRefresh();
    }
  };

  const label = t(HOOK_LABEL_KEY[hook.state]);

  return (
    // The header is tight; the label truncates rather than overflowing, and
    // the native title tooltip carries the full text (same as Report a bug).
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      {/* eslint-disable-next-line i18next/no-literal-string -- status glyph, not prose */}
      <Text span style={{ color: HOOK_DOT_COLOR[hook.state], lineHeight: 1, flex: "none" }}>
        ●
      </Text>
      <Text span size="sm" c="dimmed" truncate title={label}>
        {label}
      </Text>
      {ACTIONABLE_HOOK_STATES.includes(hook.state) &&
        (hook.supportsEject ? (
          <Button size="compact-xs" variant="light" loading={busy} onClick={onRefresh} style={{ flex: "none" }}>
            {t("ui.hook-status.refresh")}
          </Button>
        ) : (
          <Text span size="xs" c="dimmed" truncate title={t("ui.hook-status.restart-game")}>
            {t("ui.hook-status.restart-game")}
          </Text>
        ))}
    </Group>
  );
}
