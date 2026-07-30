import useSettings from "@/pages/useSettings";
import { Checkbox, Stack, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** What the meter reveals about the people in the party. */
export const NamesSection = () => {
  const { t } = useTranslation();
  const { show_display_names, streamer_mode, highlight_illegal_builds, setMeterSettings } = useSettings();

  return (
    <Stack gap="xs">
      <Text size="md" fw={700}>
        {t("ui.meter-names-section")}
      </Text>
      <Checkbox
        label={t("ui.show-player-names")}
        checked={show_display_names}
        onChange={(event) => setMeterSettings({ show_display_names: event.currentTarget.checked })}
      />
      <Tooltip label={t("ui.streamer-mode-description")}>
        <Checkbox
          label={t("ui.streamer-mode")}
          checked={streamer_mode}
          onChange={(event) => setMeterSettings({ streamer_mode: event.currentTarget.checked })}
        />
      </Tooltip>
      <Tooltip label={t("ui.highlight-illegal-builds-description")}>
        <Checkbox
          label={t("ui.highlight-illegal-builds")}
          checked={highlight_illegal_builds}
          onChange={(event) => setMeterSettings({ highlight_illegal_builds: event.currentTarget.checked })}
        />
      </Tooltip>
    </Stack>
  );
};
