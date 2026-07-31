import useSettings from "@/pages/useSettings";
import { Checkbox, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsSection";

/** What the meter reveals about the people in the party. */
export const NamesSection = () => {
  const { t } = useTranslation();
  const { show_display_names, streamer_mode, show_flagged_builds, highlight_illegal_builds, setMeterSettings } =
    useSettings();

  return (
    <SettingsSection title={t("ui.meter-names-section")}>
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
      {/* Narrower than the General tab's master switch and sits under it, so
          with that one off this cannot put a coloured name back on screen —
          disabled rather than silently ineffective, and the tooltip says where
          to go. */}
      <Tooltip
        label={
          show_flagged_builds
            ? t("ui.highlight-illegal-builds-description")
            : t("ui.highlight-illegal-builds-requires-flagged")
        }
        multiline
        w={320}
      >
        {/* A disabled Checkbox fires no pointer events, so the Tooltip needs a
            wrapper that does — otherwise the explanation is unreachable
            exactly when it is needed. */}
        <div>
          <Checkbox
            label={t("ui.highlight-illegal-builds")}
            checked={highlight_illegal_builds}
            disabled={!show_flagged_builds}
            onChange={(event) => setMeterSettings({ highlight_illegal_builds: event.currentTarget.checked })}
          />
        </div>
      </Tooltip>
    </SettingsSection>
  );
};
