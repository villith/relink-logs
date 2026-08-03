import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";

import { invoke } from "@tauri-apps/api";
import { readTextFile } from "@tauri-apps/api/fs";
import { resolveResource } from "@tauri-apps/api/path";

import { insideTauri, registerDurableKey } from "@/stores/durableStorage";

import { applyRemoteLanguage, LANGUAGE_KEY } from "./i18nDurable";

const loadLanguageFromPath = async (language: string, namespace: string) => {
  const resourcePath = await resolveResource(`lang/${language}/${namespace}.json`);
  return JSON.parse(await readTextFile(resourcePath));
};

export const SUPPORTED_LANGUAGES: { [key: string]: string } = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "ko-KR": "한국어",
  jp: "日本語",
  "fr-FR": "Français",
  bp: "Brazillian Portuguese",
  ge: "Deutsch",
  "es-ES": "Español",
  "it-IT": "Italiano",
};

/** Pushes the localized system-tray menu strings to the backend. */
export const syncTrayLabels = async () => {
  if (!insideTauri()) return;
  try {
    await invoke("update_tray_labels", {
      openMeter: i18n.t("ui.tray-open-meter"),
      openLogs: i18n.t("ui.tray-open-logs"),
      alwaysOnTop: i18n.t("ui.tray-always-on-top"),
      alwaysOnTopActive: i18n.t("ui.tray-always-on-top-active"),
      clickthrough: i18n.t("ui.tray-clickthrough"),
      clickthroughActive: i18n.t("ui.tray-clickthrough-active"),
      resetWindows: i18n.t("ui.tray-reset-windows"),
      // Only present in dev builds; the backend ignores it otherwise.
      reloadHook: i18n.t("ui.tray-reload-hook"),
      quit: i18n.t("ui.tray-quit"),
    });
  } catch (e) {
    console.warn("[i18n] Failed to sync tray labels:", e);
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .use(
    resourcesToBackend((language, namespace, callback) => {
      loadLanguageFromPath(language, namespace)
        .then((res) => callback(null, res))
        .catch((error) => callback(error, null));
    })
  )
  .init({
    ns: [
      "ui",
      "abilities",
      "characters",
      "items",
      "overmasteries",
      "sigils",
      "traits",
      "weapons",
      "quests",
      "enemies",
      "summons",
      "summon-classes",
      "primal-bursts",
      "summon-bonuses",
      "skillboard",
      "skillboard-branches",
      "statuses",
    ],
    defaultNS: "ui",
    fallbackLng: {
      default: ["en"],
      "zh-TW": ["zh-CN", "en"],
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      bindI18n: "languageChanged loaded",
      bindI18nStore: "added",
    },
  });

i18n.on("initialized", () => void syncTrayLabels());
// Deliberately NOT the place the language is persisted from. i18next emits
// `languageChanged` from `init()` too, carrying whatever its detector found —
// and on the launch this whole feature exists to repair, the detector finds an
// empty localStorage and falls back to the navigator language. Mirroring that
// would race `bootstrapDurableSettings()` restoring the stored language and
// could overwrite it with `en`. Persisting is the user action's job; see
// `handleLanguageChange` in `pages/useSettings.ts`. A language that only ever
// lived in the cache is picked up by the bootstrap's adoption pass instead.
i18n.on("languageChanged", () => void syncTrayLabels());

// The language is the one durable key the adapter does not own: i18next's
// detector writes the localStorage half itself.
registerDurableKey(LANGUAGE_KEY, applyRemoteLanguage);

declare global {
  interface Window {
    /* eslint-disable */
    i18n: any;
  }
}

window.i18n = i18n;

export default i18n;
