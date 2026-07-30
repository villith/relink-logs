import useSettings from "@/pages/useSettings";
import { DEFAULT_OVERLAY_SIZE, OVERLAY_MIN_SIZE } from "@/stores/useMeterSettingsStore";
import { Anchor, Group, NumberInput, SimpleGrid, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The overlay window's size, in logical pixels.
 *
 * Two-way: typing here resizes the overlay, and dragging the overlay's edge
 * writes the new size back into these fields (see useOverlaySize). Worth having
 * as numbers rather than only a drag handle because the narrow-header rule is a
 * width threshold — you cannot aim at it by dragging.
 */
export const OverlaySizeSection = () => {
  const { t } = useTranslation();
  const { overlay_width, overlay_height, setMeterSettings } = useSettings();

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="md" fw={700}>
          {t("ui.overlay-size-section")}
        </Text>
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => setMeterSettings({ ...DEFAULT_OVERLAY_SIZE })}
        >
          {t("ui.reset-to-defaults")}
        </Anchor>
      </Group>
      <Text size="xs" c="dimmed">
        {t("ui.overlay-size-description")}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <NumberInput
          label={t("ui.overlay-width")}
          min={OVERLAY_MIN_SIZE.width}
          max={4000}
          step={10}
          clampBehavior="strict"
          suffix="px"
          value={overlay_width}
          onChange={(value) => typeof value === "number" && setMeterSettings({ overlay_width: value })}
        />
        <NumberInput
          label={t("ui.overlay-height")}
          min={OVERLAY_MIN_SIZE.height}
          max={4000}
          step={10}
          clampBehavior="strict"
          suffix="px"
          value={overlay_height}
          onChange={(value) => typeof value === "number" && setMeterSettings({ overlay_height: value })}
        />
      </SimpleGrid>
    </Stack>
  );
};
