import { Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** Settings → Overlay: the settings that apply ONLY to the always-on-top game
 * overlay. Everything that also affects the meter in the Logs window lives in
 * Settings → Meters. */
const OverlaySettings = () => {
  const { t } = useTranslation();
  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.overlay-settings")}</Title>
    </Stack>
  );
};

export default OverlaySettings;
