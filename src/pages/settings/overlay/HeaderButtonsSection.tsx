import useSettings from "@/pages/useSettings";
import { DEFAULT_HEADER_BUTTONS, HEADER_BUTTONS, type HeaderButtonId } from "@/stores/useMeterSettingsStore";
import { Anchor, Group, Stack, Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * Which action buttons the overlay header carries.
 *
 * Minimize is not listed because it has no toggle: leaving one guaranteed way
 * to push the overlay aside is worth more than the pixel it costs.
 */
export const HeaderButtonsSection = () => {
  const { t } = useTranslation();
  const { header_buttons, setMeterSettings } = useSettings();

  // Defaults underneath, so a settings blob saved before a button existed does
  // not read as "user hid it".
  const shown = { ...DEFAULT_HEADER_BUTTONS, ...header_buttons };

  const toggle = (id: HeaderButtonId, checked: boolean) =>
    setMeterSettings({ header_buttons: { ...shown, [id]: checked } });

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="md" fw={700}>
          {t("ui.header-buttons-section")}
        </Text>
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => setMeterSettings({ header_buttons: { ...DEFAULT_HEADER_BUTTONS } })}
        >
          {t("ui.reset-to-defaults")}
        </Anchor>
      </Group>
      <Text size="xs" c="dimmed">
        {t("ui.header-buttons-description")}
      </Text>
      <Group gap="lg">
        {HEADER_BUTTONS.map((id) => (
          <Switch
            key={id}
            size="sm"
            label={t(`ui.header-button.${id}`)}
            checked={shown[id]}
            onChange={(event) => toggle(id, event.currentTarget.checked)}
          />
        ))}
      </Group>
    </Stack>
  );
};
