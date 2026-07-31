import { HEADER_BUTTON_ICONS } from "@/components/TitlebarButtons";
import useSettings from "@/pages/useSettings";
import {
  DEFAULT_HEADER_BUTTONS,
  HEADER_BUTTONS,
  headerButtonsWithDefaults,
  type HeaderButtonId,
} from "@/stores/useMeterSettingsStore";
import { Anchor, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * Which action buttons the overlay header carries.
 *
 * Each one is labelled with the glyph it draws in the header as well as its
 * name, so the row reads as the header it edits. Minimize is not listed because
 * it has no toggle: leaving one guaranteed way to push the overlay aside is
 * worth more than the pixel it costs.
 */
export const HeaderButtonsSection = () => {
  const { t } = useTranslation();
  const { header_buttons, setMeterSettings } = useSettings();

  const shown = headerButtonsWithDefaults(header_buttons);

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
      <Group gap="lg">
        {HEADER_BUTTONS.map((id) => {
          const Icon = HEADER_BUTTON_ICONS[id];
          return (
            <Checkbox
              key={id}
              label={
                <Group gap={6} wrap="nowrap">
                  <Icon size={16} />
                  {t(`ui.header-button.${id}`)}
                </Group>
              }
              checked={shown[id]}
              onChange={(event) => toggle(id, event.currentTarget.checked)}
            />
          );
        })}
      </Group>
    </Stack>
  );
};
