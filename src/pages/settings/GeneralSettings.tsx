import NewChip from "@/components/NewChip";
import useSettings from "@/pages/useSettings";
import { useIsLinux } from "@/platform";
import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useManualUpdateCheck } from "@/useUpdateCheck";
import { Button, Checkbox, Divider, Group, Select, Stack, Text, Title, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
    setMeterSettings,
  } = useSettings();
  const { checking, checkNow } = useManualUpdateCheck();
  const { deleteAllLogs } = useLogIndexStore((state) => ({ deleteAllLogs: state.deleteAllLogs }));

  const confirmDeleteAll = () =>
    modals.openConfirmModal({
      title: t("ui.logs.delete-logs-title", "Delete logs"),
      children: <Text size="sm">{t("ui.logs.delete-all-logs-confirmation")}</Text>,
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteAllLogs(),
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
        {t("ui.logs-tab")}
      </Text>
      <Button variant="default" onClick={confirmDeleteAll} style={{ alignSelf: "flex-start" }}>
        {t("ui.logs.delete-all-btn")}
      </Button>
      {isLinux && <LinuxSetupSection />}
    </Stack>
  );
};

export default GeneralSettings;
