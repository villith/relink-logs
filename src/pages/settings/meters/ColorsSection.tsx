import useSettings from "@/pages/useSettings";
import { DEFAULT_METER_COLORS } from "@/stores/useMeterSettingsStore";
import { Anchor, ColorPicker, ColorSwatch, Group, Popover, Stack, Text, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The four party-slot bar colours, as swatches.
 *
 * One row of swatches rather than four labelled text inputs: this is one
 * decision made by comparing four colours against each other, and the hex value
 * is something you check occasionally, not something worth four inputs of
 * permanent screen space.
 */
export const ColorsSection = () => {
  const { t } = useTranslation();
  const { color_1, color_2, color_3, color_4, setMeterSettings } = useSettings();

  const colors = [
    { key: "color_1", value: color_1, slot: 1 },
    { key: "color_2", value: color_2, slot: 2 },
    { key: "color_3", value: color_3, slot: 3 },
    { key: "color_4", value: color_4, slot: 4 },
  ] as const;

  const reset = () =>
    setMeterSettings({
      color_1: DEFAULT_METER_COLORS[0],
      color_2: DEFAULT_METER_COLORS[1],
      color_3: DEFAULT_METER_COLORS[2],
      color_4: DEFAULT_METER_COLORS[3],
    });

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="md" fw={700}>
          {t("ui.meter-colors-section")}
        </Text>
        <Anchor component="button" type="button" size="xs" onClick={reset}>
          {t("ui.reset-to-defaults")}
        </Anchor>
      </Group>
      <Group gap="sm">
        {colors.map((color) => (
          <Popover key={color.key} position="bottom-start" withArrow shadow="md">
            <Popover.Target>
              <ColorSwatch
                component="button"
                type="button"
                color={color.value}
                size={32}
                style={{ cursor: "pointer" }}
                aria-label={t("ui.player-slot-color", { slot: color.slot })}
                title={t("ui.player-slot-color", { slot: color.slot })}
              >
                <Text size="xs" fw={700} c="white">
                  {color.slot}
                </Text>
              </ColorSwatch>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <ColorPicker
                  format="hex"
                  value={color.value}
                  onChange={(value) => setMeterSettings({ [color.key]: value })}
                />
                <TextInput
                  size="xs"
                  value={color.value}
                  aria-label={t("ui.player-slot-color", { slot: color.slot })}
                  onChange={(event) => setMeterSettings({ [color.key]: event.currentTarget.value })}
                />
              </Stack>
            </Popover.Dropdown>
          </Popover>
        ))}
      </Group>
    </Stack>
  );
};
