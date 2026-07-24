import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";

import { readTextFile } from "@tauri-apps/api/fs";
import { resolveResource } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api";

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

const syncTrayLabels = async () => {
  if (!("__TAURI_IPC__" in window)) return;
  try {
    await invoke("update_tray_labels", {
      openMeter: i18n.t("ui.tray-open-meter"),
      openLogs: i18n.t("ui.tray-open-logs"),
      alwaysOnTop: i18n.t("ui.tray-always-on-top"),
      alwaysOnTopActive: i18n.t("ui.tray-always-on-top-active"),
      clickthrough: i18n.t("ui.tray-clickthrough"),
      clickthroughActive: i18n.t("ui.tray-clickthrough-active"),
      resetWindows: i18n.t("ui.tray-reset-windows"),
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
      "summon-bonuses",
      "skillboard",
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
i18n.on("languageChanged", () => void syncTrayLabels());

declare global {
  interface Window {
    /* eslint-disable */
    i18n: any;
  }
}

window.i18n = i18n;

export default i18n;
