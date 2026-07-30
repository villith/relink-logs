import useSettings from "@/pages/useSettings";
import { ColorInput, SimpleGrid, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** The four party-slot bar colours. Laid out across the width rather than as
 * four stacked full-width inputs — they are one decision, made by comparing
 * them against each other. */
export const ColorsSection = () => {
  const { t } = useTranslation();
  const { color_1, color_2, color_3, color_4, setMeterSettings } = useSettings();

  const colors = [
    { key: "color_1", value: color_1, label: t("ui.player-1-color") },
    { key: "color_2", value: color_2, label: t("ui.player-2-color") },
    { key: "color_3", value: color_3, label: t("ui.player-3-color") },
    { key: "color_4", value: color_4, label: t("ui.player-4-color") },
  ] as const;

  return (
    <Stack gap="xs">
      <Text size="md" fw={700}>
        {t("ui.meter-colors-section")}
      </Text>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        {colors.map((color) => (
          <ColorInput
            key={color.key}
            defaultValue={color.value}
            onChangeEnd={(value) => setMeterSettings({ [color.key]: value })}
            withEyeDropper={false}
            label={color.label}
            placeholder={t("ui.color-placeholder", "Color")}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
};
