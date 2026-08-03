import NewChip from "@/components/NewChip";
import useSettings from "@/pages/useSettings";
import { useIsLinux } from "@/platform";
import { type SkillNameResolutionMode } from "@/skillNameSources";
import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useManualUpdateCheck } from "@/useUpdateCheck";
import { Button, Checkbox, Divider, Group, Select, Stack, Text, Title, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { openImportLogsModal } from "./ImportLogsModal";
import { openImportSettingsModal } from "./ImportSettingsModal";
import { LinuxSetupSection } from "./LinuxSetupSection";

/** Settings → General: app-wide preferences (language, updates, debug) and the
 * destructive log-store action, plus the Linux hook setup panel where it
 * applies. */
const GeneralSettings = () => {
  const { t, i18n } = useTranslation();
  const [debugMode, setDebugMode] = useState(false);
  const isLinux = useIsLinux();

  const {
    languages,
    handleLanguageChange,
    open_log_on_save,
    auto_check_updates,
    show_flagged_builds,
    skill_name_resolution,
    setMeterSettings,
  } = useSettings();
  const { checking, checkNow } = useManualUpdateCheck();
  const { deleteAllLogs, deleteImportedLogs } = useLogIndexStore((state) => ({
    deleteAllLogs: state.deleteAllLogs,
    deleteImportedLogs: state.deleteImportedLogs,
  }));
  const [exporting, setExporting] = useState<"logs" | "settings" | null>(null);

  // Counts first so the confirmation can say how many logs it is about to
  // delete; with none there is nothing to confirm, so it only informs.
  const confirmDeleteImported = async () => {
    let count: number;
    try {
      count = await invoke<number>("count_imported_logs");
    } catch (e) {
      toast.error(t("ui.delete-imported-logs-error", { error: String(e) }));
      return;
    }
    if (count === 0) {
      toast(t("ui.delete-imported-logs-none"));
      return;
    }
    modals.openConfirmModal({
      title: t("ui.logs.delete-logs-title"),
      children: <Text size="sm">{t("ui.delete-imported-logs-confirmation", { count })}</Text>,
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          const count = await deleteImportedLogs();
          toast.success(t("ui.delete-imported-logs-result", { count }));
        } catch (e) {
          toast.error(t("ui.delete-imported-logs-error", { error: String(e) }));
        }
      },
    });
  };

  // A full standalone snapshot of one of the two databases, written wherever
  // the save dialog points. A null path means the dialog was cancelled.
  const exportDb = async (db: "logs" | "settings") => {
    setExporting(db);
    try {
      const path = await invoke<string | null>(`export_${db}_db`);
      if (path) toast.success(t(`ui.export-${db}-result`, { path }));
    } catch (e) {
      toast.error(t(`ui.export-${db}-error`, { error: String(e) }));
    } finally {
      setExporting(null);
    }
  };

  const confirmDeleteAll = () =>
    modals.openConfirmModal({
      title: t("ui.logs.delete-logs-title"),
      children: <Text size="sm">{t("ui.logs.delete-all-logs-confirmation")}</Text>,
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteAllLogs(),
    });

  // On success every window (this one included) clears its cached settings
  // and reloads onto defaults — no toast needed, the page restarting is the
  // feedback.
  const confirmResetSettings = () =>
    modals.openConfirmModal({
      title: t("ui.reset-settings-title"),
      children: <Text size="sm">{t("ui.reset-settings-confirmation")}</Text>,
      labels: { confirm: t("ui.reset-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await invoke("reset_settings_to_default");
        } catch (e) {
          toast.error(t("ui.reset-settings-error", { error: String(e) }));
        }
      },
    });

  const toggleDebugMode = () => {
    const enabled = !debugMode;
    setDebugMode(enabled);
    invoke("set_debug_mode", { enabled });
    console.info("Debug Mode:", enabled ? "Enabled" : "Disabled");
  };

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.settings-nav.general", "General")}</Title>
      <Select
        label={t("ui.language")}
        data={languages}
        defaultValue={i18n.language}
        allowDeselect={false}
        onChange={handleLanguageChange}
      />
      <Group gap="sm" align="flex-end">
        <Tooltip label={t("ui.skill-name-resolution-description")} multiline w={360}>
          <Select
            label={t("ui.skill-name-resolution")}
            data={[
              { value: "language-first", label: t("ui.skill-name-resolution-language-first") },
              { value: "label-first", label: t("ui.skill-name-resolution-label-first") },
            ]}
            value={skill_name_resolution}
            allowDeselect={false}
            w={360}
            onChange={(value) => value && setMeterSettings({ skill_name_resolution: value as SkillNameResolutionMode })}
          />
        </Tooltip>
        <NewChip id="skill-name-resolution" />
      </Group>
      <Tooltip label={t("ui.open-log-on-save-description")}>
        <Checkbox
          label={t("ui.open-log-on-save")}
          checked={open_log_on_save}
          onChange={(event) => setMeterSettings({ open_log_on_save: event.currentTarget.checked })}
        />
      </Tooltip>
      <Group gap="sm">
        <Tooltip label={t("ui.auto-check-updates-description")}>
          <Checkbox
            label={t("ui.auto-check-updates")}
            checked={auto_check_updates}
            onChange={(event) => setMeterSettings({ auto_check_updates: event.currentTarget.checked })}
          />
        </Tooltip>
        <Button size="compact-sm" variant="light" onClick={checkNow} loading={checking}>
          {t("ui.check-updates")}
        </Button>
      </Group>
      {/* The master switch for every cheat-audit verdict outside the Cheat
          Audit page itself. Off by default — the app does not accuse anyone on
          the user's behalf until asked. */}
      <Group gap="sm">
        <Tooltip label={t("ui.show-flagged-builds-description")} multiline w={320}>
          <Checkbox
            label={t("ui.show-flagged-builds")}
            checked={show_flagged_builds}
            onChange={(event) => setMeterSettings({ show_flagged_builds: event.currentTarget.checked })}
          />
        </Tooltip>
        <NewChip id="flagged-builds-setting" />
      </Group>
      <Tooltip label={t("ui.debug-mode-description")}>
        <Checkbox label={t("ui.debug-mode")} checked={debugMode} onChange={toggleDebugMode} />
      </Tooltip>
      <Divider />
      <Text size="md" fw={700}>
        {t("ui.data-management")} <NewChip id="import-export-logs" />
      </Text>
      <Group gap="sm">
        <Button variant="default" onClick={() => openImportLogsModal(t("ui.import-logs-modal.title"))}>
          {t("ui.import-logs-btn")}
        </Button>
        <Button variant="default" onClick={() => exportDb("logs")} disabled={exporting !== null}>
          {t("ui.export-logs-btn")}
        </Button>
        <Button variant="filled" color="red" onClick={confirmDeleteImported}>
          {t("ui.delete-imported-logs-btn")}
        </Button>
        <Button variant="filled" color="red" onClick={confirmDeleteAll}>
          {t("ui.logs.delete-all-btn")}
        </Button>
      </Group>
      <Text size="md" fw={700}>
        {t("ui.settings-management")} <NewChip id="import-export-settings" />
      </Text>
      <Group gap="sm">
        <Button variant="default" onClick={() => openImportSettingsModal(t("ui.import-settings-modal.title"))}>
          {t("ui.import-settings-btn")}
        </Button>
        <Button variant="default" onClick={() => exportDb("settings")} disabled={exporting !== null}>
          {t("ui.export-settings-btn")}
        </Button>
        <Button variant="filled" color="red" onClick={confirmResetSettings}>
          {t("ui.reset-settings-btn")}
        </Button>
      </Group>
      {isLinux && <LinuxSetupSection />}
    </Stack>
  );
};

export default GeneralSettings;
