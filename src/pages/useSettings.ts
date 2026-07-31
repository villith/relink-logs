import { SUPPORTED_LANGUAGES } from "@/i18n";
import { broadcastLanguage, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { useTranslation } from "react-i18next";

export default function useSettings() {
  const {
    color_1,
    color_2,
    color_3,
    color_4,
    transparency,
    show_display_names,
    streamer_mode,
    show_flagged_builds,
    highlight_illegal_builds,
    show_full_values,
    use_condensed_skills,
    include_primal_burst,
    open_log_on_save,
    auto_check_updates,
    player_label_template,
    header_segments,
    header_buttons,
    overlay_width,
    overlay_height,
    bar_fill_mode,
    bar_texture,
    bar_height,
    bar_spacing,
    setMeterSettings,
  } = useMeterSettingsStore((state) => ({
    color_1: state.color_1,
    color_2: state.color_2,
    color_3: state.color_3,
    color_4: state.color_4,
    transparency: state.transparency,
    show_display_names: state.show_display_names,
    streamer_mode: state.streamer_mode,
    show_flagged_builds: state.show_flagged_builds,
    highlight_illegal_builds: state.highlight_illegal_builds,
    show_full_values: state.show_full_values,
    use_condensed_skills: state.use_condensed_skills,
    include_primal_burst: state.include_primal_burst,
    open_log_on_save: state.open_log_on_save,
    auto_check_updates: state.auto_check_updates,
    player_label_template: state.player_label_template,
    header_segments: state.header_segments,
    header_buttons: state.header_buttons,
    overlay_width: state.overlay_width,
    overlay_height: state.overlay_height,
    bar_fill_mode: state.bar_fill_mode,
    bar_texture: state.bar_texture,
    bar_height: state.bar_height,
    bar_spacing: state.bar_spacing,
    setMeterSettings: state.set,
  }));

  const { i18n } = useTranslation();

  const handleLanguageChange = (language: string | null) => {
    if (!language) return;
    i18n.changeLanguage(language);
    broadcastLanguage(language);
  };

  const languages = Object.keys(SUPPORTED_LANGUAGES).map((key) => ({ value: key, label: SUPPORTED_LANGUAGES[key] }));

  return {
    color_1,
    color_2,
    color_3,
    color_4,
    transparency,
    show_display_names,
    streamer_mode,
    show_flagged_builds,
    highlight_illegal_builds,
    show_full_values,
    use_condensed_skills,
    include_primal_burst,
    setMeterSettings,
    languages,
    open_log_on_save,
    auto_check_updates,
    player_label_template,
    header_segments,
    header_buttons,
    overlay_width,
    overlay_height,
    bar_fill_mode,
    bar_texture,
    bar_height,
    bar_spacing,
    handleLanguageChange,
  };
}
