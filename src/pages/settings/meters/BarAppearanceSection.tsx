import useSettings from "@/pages/useSettings";
import { useIsLinux } from "@/platform";
import { BAR_TEXTURES, DEFAULT_BAR_APPEARANCE, type BarFillMode } from "@/stores/useMeterSettingsStore";
import { Select, SimpleGrid, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsSection";
import { LabelledSlider } from "./LabelledSlider";

/** How the meter's damage bars are drawn: fill rule, texture, row size. */
export const BarAppearanceSection = () => {
  const { t } = useTranslation();
  const { bar_fill_mode, bar_texture, bar_height, bar_spacing, setMeterSettings } = useSettings();

  // Textures are a Windows-only nicety: they are gradients delivered through a
  // CSS custom property, and verifying that path on WebKitGTK is not worth it
  // for something cosmetic. Only the CONTROL is gated — useIsLinux resolves
  // asynchronously, so branching the renderer would flash a texture for a frame
  // on every overlay launch. A Linux-only user simply never leaves "solid".
  const isLinux = useIsLinux();

  const reset = () => setMeterSettings({ ...DEFAULT_BAR_APPEARANCE });

  return (
    <SettingsSection title={t("ui.bar-appearance-section")} onReset={reset}>
      {/* The fill-mode description sits here rather than on its Select: as a
          two-line `description` it made that Select 60px taller than the one
          beside it, so the pair no longer lined up. */}
      <Text size="xs" c="dimmed">
        {t("ui.bar-fill-mode-description")}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Select
          label={t("ui.bar-fill-mode")}
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
      {/* Paired: neither slider needs the full width, and side by side they read
          as the two halves of one row-geometry decision. */}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <LabelledSlider
          label={t("ui.bar-height")}
          min={16}
          max={48}
          step={1}
          unit="px"
          value={bar_height}
          onChange={(value) => setMeterSettings({ bar_height: value })}
        />
        <LabelledSlider
          label={t("ui.bar-spacing")}
          min={0}
          max={8}
          step={1}
          unit="px"
          value={bar_spacing}
          onChange={(value) => setMeterSettings({ bar_spacing: value })}
        />
      </SimpleGrid>
    </SettingsSection>
  );
};
