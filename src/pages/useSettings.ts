import { SUPPORTED_LANGUAGES } from "@/i18n";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
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
    show_full_values,
    use_condensed_skills,
    open_log_on_save,
    auto_check_updates,
    setMeterSettings,
  } = useMeterSettingsStore((state) => ({
    color_1: state.color_1,
    color_2: state.color_2,
    color_3: state.color_3,
    color_4: state.color_4,
    transparency: state.transparency,
    show_display_names: state.show_display_names,
    streamer_mode: state.streamer_mode,
    show_full_values: state.show_full_values,
    use_condensed_skills: state.use_condensed_skills,
    open_log_on_save: state.open_log_on_save,
    auto_check_updates: state.auto_check_updates,
    setMeterSettings: state.set,
  }));

  const { i18n } = useTranslation();

  const handleLanguageChange = (language: string | null) => {
    i18n.changeLanguage(language as string);
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
    show_full_values,
    use_condensed_skills,
    setMeterSettings,
    languages,
    open_log_on_save,
    auto_check_updates,
    handleLanguageChange,
  };
}
