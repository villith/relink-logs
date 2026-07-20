import { Divider, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { DownloadSimple } from "@phosphor-icons/react";
import { UpdateManifest, checkUpdate, installUpdate } from "@tauri-apps/api/updater";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import UpdateNotes from "@/components/UpdateNotes";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { useUpdateStatusStore } from "@/stores/useUpdateStatusStore";

/** Both check paths feed the header's version indicator. */
const recordStatus = (shouldUpdate: boolean, manifest?: UpdateManifest) =>
  useUpdateStatusStore.getState().record({ upToDate: !shouldUpdate, latestVersion: manifest?.version ?? null });

/** Loose t: real components pass react-i18next's t, tests a stub. */
type Translator = (key: string, options?: Record<string, unknown>) => string;

/** The "update available" confirm dialog: release notes as the body,
 * install on confirm. On Windows the app exits into the installer, so
 * nothing happens after a successful install call. */
const openUpdatePrompt = (t: Translator, manifest?: UpdateManifest) => {
  modals.openConfirmModal({
    centered: true,
    title: (
      <Group gap="xs" wrap="nowrap">
        <DownloadSimple size="1.1rem" weight="bold" />
        <Text fw={600}>{t("ui.update-available", { version: manifest?.version })}</Text>
      </Group>
    ),
    children: (
      <Stack gap="sm">
        <Divider />
        <ScrollArea.Autosize mah={320} type="auto" offsetScrollbars>
          <UpdateNotes markdown={manifest?.body ?? ""} />
        </ScrollArea.Autosize>
        <Divider />
      </Stack>
    ),
    labels: { confirm: t("ui.update-now"), cancel: t("ui.update-skip") },
    confirmProps: { leftSection: <DownloadSimple size="1rem" /> },
    onConfirm: () => {
      installUpdate().catch(() => toast.error(t("ui.update-failed")));
    },
    // Only the explicit Skip button suppresses this version; closing the
    // modal any other way leaves it offered again next run.
    onCancel: () => {
      if (manifest?.version) useMeterSettingsStore.getState().set({ skipped_update_version: manifest.version });
    },
  });
};

/**
 * When `enabled`, asks the update endpoint once whether a newer release
 * exists and offers it via the update prompt. Requires `updater.dialog:
 * false` in tauri.conf.json; failures (offline, endpoint gone) stay silent.
 */
export default function useUpdateCheck(enabled: boolean) {
  const { t } = useTranslation();
  // One endpoint check (and so at most one prompt) per app run, across
  // setting toggles, language changes, and re-renders.
  const checked = useRef(false);

  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    checkUpdate()
      .then(({ shouldUpdate, manifest }) => {
        recordStatus(shouldUpdate, manifest);
        if (!shouldUpdate) return;
        if (manifest?.version && manifest.version === useMeterSettingsStore.getState().skipped_update_version) return;
        openUpdatePrompt(t, manifest);
      })
      .catch(() => {
        // Offline or the endpoint is unreachable — try again next launch.
      });
  }, [enabled, t]);
}

/** A user-initiated check (Settings button): always answers — with the
 * update prompt, an up-to-date toast, or an error toast. */
export const useManualUpdateCheck = () => {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      const { shouldUpdate, manifest } = await checkUpdate();
      recordStatus(shouldUpdate, manifest);
      if (shouldUpdate) openUpdatePrompt(t, manifest);
      else toast.success(t("ui.up-to-date"));
    } catch {
      toast.error(t("ui.update-check-failed"));
    } finally {
      setChecking(false);
    }
  };

  return { checking, checkNow };
};
