import { ActionIcon } from "@mantine/core";
import { DownloadSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { useManualUpdateCheck } from "@/pages/useUpdateCheck";
import { useUpdateStatusStore } from "@/stores/useUpdateStatusStore";

/**
 * Header affordance shown only while an update is known to be available.
 * Clicking runs the manual check, which reopens the update prompt with a
 * fresh manifest — also for a version the user skipped earlier.
 */
const UpdateAvailableButton = () => {
  const { t } = useTranslation();
  const status = useUpdateStatusStore((state) => state.status);
  const { checking, checkNow } = useManualUpdateCheck();

  if (!status || status.upToDate) return null;
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      title={t("ui.open-update-prompt")}
      aria-label={t("ui.open-update-prompt")}
      loading={checking}
      onClick={checkNow}
    >
      <DownloadSimple size="1rem" />
    </ActionIcon>
  );
};

export default UpdateAvailableButton;
