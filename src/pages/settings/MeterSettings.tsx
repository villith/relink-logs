import { ColumnEditor } from "@/components/ColumnEditor";
import { useColumnControls } from "@/components/useColumnControls";
import useSettings from "@/pages/useSettings";
import { Checkbox, ColorInput, Divider, Slider, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** Settings → Meters: how the meter renders, in the overlay and in the Logs
 * quest details. The colors, transparency and name/streamer switches are
 * overlay-only; the value/skill switches below them feed the shared meter
 * table, so they apply in both places. */
const MeterSettings = () => {
  const { t } = useTranslation();
  const {
    color_1,
    color_2,
    color_3,
    color_4,
    transparency,
    show_display_names,
    streamer_mode,
    show_full_values,
    use_condensed_skills,
    include_primal_burst,
    setMeterSettings,
  } = useSettings();

  const { overlayPlayer, overlaySkill } = useColumnControls();

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.meter-settings")}</Title>
      <ColorInput
        defaultValue={color_1}
        onChangeEnd={(value) => setMeterSettings({ color_1: value })}
        withEyeDropper={false}
        label={t("ui.player-1-color")}
        placeholder={t("ui.color-placeholder", "Color")}
      />
      <ColorInput
        defaultValue={color_2}
        onChangeEnd={(value) => setMeterSettings({ color_2: value })}
        withEyeDropper={false}
        label={t("ui.player-2-color")}
        placeholder={t("ui.color-placeholder", "Color")}
      />
      <ColorInput
        defaultValue={color_3}
        onChangeEnd={(value) => setMeterSettings({ color_3: value })}
        withEyeDropper={false}
        label={t("ui.player-3-color")}
        placeholder={t("ui.color-placeholder", "Color")}
      />
      <ColorInput
        defaultValue={color_4}
        onChangeEnd={(value) => setMeterSettings({ color_4: value })}
        withEyeDropper={false}
        label={t("ui.player-4-color")}
        placeholder={t("ui.color-placeholder", "Color")}
      />
      <Text size="sm">{t("ui.meter-transparency")}</Text>
      <Slider
        min={0}
        max={1}
        step={0.005}
        defaultValue={transparency}
        onChangeEnd={(value) => setMeterSettings({ transparency: value })}
      />
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
      <Divider />
      <Text size="md" fw={700}>
        {t("ui.overlay-columns-section")}
      </Text>
      <ColumnEditor
        title={t("ui.player-row")}
        droppableId="overlay-player-columns"
        translationPrefix="ui.meter-columns"
        items={overlayPlayer.items}
        onToggle={overlayPlayer.onToggle}
        onReorder={overlayPlayer.onReorder}
      />
      <ColumnEditor
        title={t("ui.skill-breakdown")}
        droppableId="overlay-skill-columns"
        translationPrefix="ui.skill-columns"
        items={overlaySkill.items}
        onToggle={overlaySkill.onToggle}
        onReorder={overlaySkill.onReorder}
      />
    </Stack>
  );
};

export default MeterSettings;
