import { durableStorage } from "@/stores/durableStorage";

/** The key i18next's browser detector caches the chosen language under. */
export const LANGUAGE_KEY = "i18nextLng";

/** Push a language change to settings.db. Goes through the same adapter as
 * every other durable key so the write rules are stated in one place —
 * i18next's detector has already written this exact value to localStorage, so
 * the cache half is a harmless no-op.
 *
 * Call this from the language picker only, never from i18next's
 * `languageChanged` event: that event also fires for the language the detector
 * guessed during `init()`, which races the bootstrap's restore and can persist
 * a fallback over the user's stored choice. */
export const mirrorLanguage = (language: string) => {
  durableStorage.setItem(LANGUAGE_KEY, language);
};

/** Apply a language that came from settings.db — either restored at startup
 * or changed in the other window. */
export const applyRemoteLanguage = (value: string | null) => {
  if (!value) return;
  if (!window.i18n || window.i18n.language === value) return;

  window.i18n.changeLanguage(value);
};
