import { SUPPORTED_LANGUAGES } from "@/i18n";
import { broadcastLanguage, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { useTranslation } from "react-i18next";

/**
 * The settings pages' view of the meter settings store, plus the language
 * picker that sits beside them.
 *
 * The store is taken whole rather than through a field-by-field selector. The
 * selector built a fresh object on every store change with no equality check,
 * so it subscribed to the entire store regardless — enumerating the fields
 * bought no narrower subscription, only three more places to edit when a
 * setting is added.
 */
export default function useSettings() {
  const settings = useMeterSettingsStore();

  const { i18n } = useTranslation();

  const handleLanguageChange = (language: string | null) => {
    if (!language) return;
    i18n.changeLanguage(language);
    broadcastLanguage(language);
  };

  const languages = Object.keys(SUPPORTED_LANGUAGES).map((key) => ({ value: key, label: SUPPORTED_LANGUAGES[key] }));

  return {
    ...settings,
    /** Named `set` on the store; the pages have always called it this. */
    setMeterSettings: settings.set,
    languages,
    handleLanguageChange,
  };
}
