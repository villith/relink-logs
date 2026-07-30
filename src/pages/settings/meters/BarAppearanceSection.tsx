import useSettings from "@/pages/useSettings";
import { useIsLinux } from "@/platform";
import { BAR_TEXTURES, type BarFillMode } from "@/stores/useMeterSettingsStore";
import { Select, SimpleGrid, Slider, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** How the meter's damage bars are drawn: fill rule, texture, row size. */
export const BarAppearanceSection = () => {
  const { t } = useTranslation();
  const { bar_fill_mode, bar_texture, bar_height, bar_spacing, transparency, setMeterSettings } = useSettings();

  // Textures are a Windows-only nicety: they are gradients delivered through a
  // CSS custom property, and verifying that path on WebKitGTK is not worth it
  // for something cosmetic. Only the CONTROL is gated — useIsLinux resolves
  // asynchronously, so branching the renderer would flash a texture for a frame
  // on every overlay launch. A Linux-only user simply never leaves "solid".
  const isLinux = useIsLinux();

  return (
    <Stack gap="xs">
      <Text size="md" fw={700}>
        {t("ui.bar-appearance-section")}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Select
          label={t("ui.bar-fill-mode")}
          description={t("ui.bar-fill-mode-description")}
          data={[
            { value: "total", label: t("ui.bar-fill-total") },
            { value: "relative", label: t("ui.bar-fill-relative") },
          ]}
          value={bar_fill_mode}
          allowDeselect={false}
          onChange={(value) => value && setMeterSettings({ bar_fill_mode: value as BarFillMode })}
        />
        {!isLinux && (
          <Select
            label={t("ui.bar-texture")}
            data={BAR_TEXTURES.map((texture) => ({ value: texture, label: t(`ui.bar-textures.${texture}`) }))}
            value={bar_texture}
            allowDeselect={false}
            onChange={(value) => value && setMeterSettings({ bar_texture: value })}
          />
        )}
      </SimpleGrid>
      <Text size="sm">{t("ui.bar-height")}</Text>
      <Slider
        min={16}
        max={48}
        step={1}
        label={(value) => `${value}px`}
        defaultValue={bar_height}
        onChangeEnd={(value) => setMeterSettings({ bar_height: value })}
      />
      <Text size="sm">{t("ui.bar-spacing")}</Text>
      <Slider
        min={0}
        max={8}
        step={1}
        label={(value) => `${value}px`}
        defaultValue={bar_spacing}
        onChangeEnd={(value) => setMeterSettings({ bar_spacing: value })}
      />
      <Text size="sm">{t("ui.meter-transparency")}</Text>
      <Slider
        min={0}
        max={1}
        step={0.005}
        defaultValue={transparency}
        onChangeEnd={(value) => setMeterSettings({ transparency: value })}
      />
    </Stack>
  );
};
