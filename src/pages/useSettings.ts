import { SUPPORTED_LANGUAGES } from "@/i18n";
import { broadcastLanguage, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { useTranslation } from "react-i18next";

/** The language picker's options. A module constant: `SUPPORTED_LANGUAGES` never
 * changes at runtime, and rebuilding this made every settings section allocate
 * a fresh list on every render for a control only one of them draws. */
const LANGUAGES = Object.keys(SUPPORTED_LANGUAGES).map((key) => ({ value: key, label: SUPPORTED_LANGUAGES[key] }));

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
  // `set` is pulled OUT of the spread rather than left in beside its alias: two
  // public names for one mutator is two things a new section could reach for,
  // with nothing to say which is meant.
  const { set, ...settings } = useMeterSettingsStore();

  const { i18n } = useTranslation();

  const handleLanguageChange = (language: string | null) => {
    if (!language) return;
    i18n.changeLanguage(language);
    broadcastLanguage(language);
  };

  return {
    ...settings,
    /** Named `set` on the store; the pages have always called it this. */
    setMeterSettings: set,
    languages: LANGUAGES,
    handleLanguageChange,
  };
}
