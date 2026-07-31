import useSettings from "@/pages/useSettings";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsSection";
import { LabelledSlider } from "../meters/LabelledSlider";

/** How opaque the overlay's background sits over the game. Overlay-only: the
 * meter in the Logs window is drawn on a normal page background. */
export const TransparencySection = () => {
  const { t } = useTranslation();
  const { transparency, setMeterSettings } = useSettings();

  return (
    <SettingsSection title={t("ui.overlay-background-section")}>
      <LabelledSlider
        label={t("ui.meter-transparency")}
        min={0}
        max={100}
        step={1}
        unit="%"
        value={Math.round(transparency * 100)}
        onChange={(value) => setMeterSettings({ transparency: value / 100 })}
      />
    </SettingsSection>
  );
};
