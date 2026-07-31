import useSettings from "@/pages/useSettings";
import { Checkbox, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsSection";

/** What the meter counts and how it writes the numbers down. Unlike the colour
 * and bar settings above, these feed the shared meter table, so they apply in
 * the overlay and the Logs quest details alike. */
export const ValuesSection = () => {
  const { t } = useTranslation();
  const { show_full_values, use_condensed_skills, include_primal_burst, setMeterSettings } = useSettings();

  return (
    <SettingsSection title={t("ui.meter-values-section")}>
      <Tooltip label={t("ui.show-full-values-description")}>
        <Checkbox
          label={t("ui.show-full-values")}
          checked={show_full_values}
          onChange={(event) => setMeterSettings({ show_full_values: event.currentTarget.checked })}
        />
      </Tooltip>
      <Tooltip label={t("ui.use-condensed-skills-description")}>
        <Checkbox
          label={t("ui.use-condensed-skills")}
          checked={use_condensed_skills}
          onChange={(event) => setMeterSettings({ use_condensed_skills: event.currentTarget.checked })}
        />
      </Tooltip>
      <Tooltip label={t("ui.include-primal-burst-description")}>
        <Checkbox
          label={t("ui.include-primal-burst")}
          checked={include_primal_burst}
          onChange={(event) => setMeterSettings({ include_primal_burst: event.currentTarget.checked })}
        />
      </Tooltip>
    </SettingsSection>
  );
};
