import { Button, Group, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import DbFilePicker from "./DbFilePicker";

const MODAL_ID = "import-settings";

/** Settings → General's "Import Settings…" flow: pick an exported settings.db
 * (or another installation's), confirm, and overwrite matching settings. No
 * dry-run stage, unlike the logs importer — settings are opaque store blobs,
 * so there is nothing meaningful to preview. */
export const openImportSettingsModal = (title: string) =>
  modals.open({
    modalId: MODAL_ID,
    title,
    size: "md",
    children: <ImportSettingsModal />,
  });

const ImportSettingsModal = () => {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);

  const pickFile = async () => {
    setPicking(true);
    try {
      const picked = await invoke<string | null>("pick_settings_db_file");
      if (picked) setPath(picked);
    } catch (e) {
      toast.error(t("ui.import-settings-error", { error: String(e) }));
    } finally {
      setPicking(false);
    }
  };

  // The backend announces every changed key to all windows, so the imported
  // settings apply live the moment this resolves.
  const runImport = async () => {
    if (!path) return;
    setImporting(true);
    try {
      await invoke<number>("import_settings_from_file", { path });
      toast.success(t("ui.import-settings-result"));
      modals.close(MODAL_ID);
    } catch (e) {
      toast.error(t("ui.import-settings-error", { error: String(e) }));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm">{t("ui.import-settings-modal.intro")}</Text>
      <DbFilePicker
        path={path}
        placeholder={t("ui.import-settings-modal.no-file")}
        browseLabel={t("ui.import-settings-modal.browse-btn")}
        onBrowse={pickFile}
        disabled={picking || importing}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => modals.close(MODAL_ID)}>
          {t("ui.cancel-btn")}
        </Button>
        <Button onClick={runImport} loading={importing} disabled={picking || !path}>
          {t("ui.import-settings-modal.import-btn")}
        </Button>
      </Group>
    </Stack>
  );
};
