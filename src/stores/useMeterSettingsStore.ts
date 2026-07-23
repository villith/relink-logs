import {
  ALL_METER_COLUMNS,
  ALL_SKILL_COLUMNS,
  buildColumns,
  ColumnSetting,
  DEFAULT_LOGS_COLUMNS,
  DEFAULT_LOGS_SKILL_COLUMNS,
  DEFAULT_OVERLAY_COLUMNS,
  DEFAULT_OVERLAY_SKILL_COLUMNS,
  MeterColumns,
  reconcileColumns,
  SkillColumns,
} from "@/types";
import { emit, listen } from "@tauri-apps/api/event";
import { create, Mutate, StoreApi } from "zustand";
import { persist } from "zustand/middleware";

interface MeterSettings {
  color_1: string;
  color_2: string;
  color_3: string;
  color_4: string;
  transparency: number;
  show_display_names: boolean;
  streamer_mode: boolean;
  show_full_values: boolean;
  use_condensed_skills: boolean;
  open_log_on_save: boolean;
  auto_check_updates: boolean;
  /** Version the user chose "Skip" for in the update prompt: the automatic
   * check stays quiet about exactly this version (manual checks still ask). */
  skipped_update_version: string | null;
  overlay_columns: ColumnSetting<MeterColumns>[];
  /** Customizable skill-breakdown value columns for the live overlay. */
  overlay_skill_columns: ColumnSetting<SkillColumns>[];
  /** Customizable player columns for the main (logs) window. */
  logs_columns: ColumnSetting<MeterColumns>[];
  /** Customizable skill-breakdown value columns for the main (logs) window. */
  logs_skill_columns: ColumnSetting<SkillColumns>[];
}

interface MeterStateFunctions {
  set: (settings: Partial<MeterSettings>) => void;
}

const DEFAULT_METER_SETTINGS: MeterSettings = {
  color_1: "#FF5630",
  color_2: "#F2D90A",
  color_3: "#36B37E",
  color_4: "#00B8D9",
  transparency: 0.2,
  show_display_names: true,
  streamer_mode: false,
  show_full_values: false,
  use_condensed_skills: true,
  open_log_on_save: true,
  auto_check_updates: true,
  skipped_update_version: null,
  overlay_columns: [...DEFAULT_OVERLAY_COLUMNS],
  overlay_skill_columns: [...DEFAULT_OVERLAY_SKILL_COLUMNS],
  logs_columns: [...DEFAULT_LOGS_COLUMNS],
  logs_skill_columns: [...DEFAULT_LOGS_SKILL_COLUMNS],
};

/* Cross-window sync. The overlay and the logs/settings window are separate
   webviews, and the DOM storage-event path (withStorageDOMEvents below) only
   works where the webviews share one browser process: on Linux, WebKitGTK
   neither fires cross-window `storage` events nor even shares localStorage
   between windows (https://github.com/tauri-apps/tauri/issues/10981), so
   settings changed in the settings page never reached the live overlay.
   Every mutation is therefore also broadcast as a Tauri event *carrying the
   changed values*; each window applies them to its own store, and persist
   then rewrites that window's own localStorage copy, keeping the per-window
   copies equal (whichever window's copy survives exit is then correct). */
export const SETTINGS_SYNC_EVENT = "meter-settings-sync";
export const LANGUAGE_SYNC_EVENT = "language-sync";

/** True while applying a broadcast from another window: those set() calls
 * must not broadcast again (the emitting window also receives its own event,
 * so re-emitting would ping-pong between windows). */
let applyingRemoteSettings = false;

/** Broadcasts a language change to the other window (the storage-event path
 * for `i18nextLng` below is Windows-only, same as for settings). */
export const broadcastLanguage = (language: string) => {
  if (insideTauri()) void emit(LANGUAGE_SYNC_EVENT, language);
};

/** The Tauri event IPC only exists inside a real Tauri window — not in
 * vitest/jsdom or a plain-browser `npm run dev`. */
const insideTauri = () => "__TAURI_IPC__" in window;

export type StoreWithPersist<T> = Mutate<StoreApi<T>, [["zustand/persist", T]]>;

export const withStorageDOMEvents = <T>(store: StoreWithPersist<T>) => {
  const storageEventCallback = (e: StorageEvent) => {
    if (e.key === "i18nextLng" && window.i18n) {
      window.i18n.changeLanguage(e.newValue);
    }

    if (e.key === store.persist?.getOptions().name && e.newValue) {
      store.persist.rehydrate();
    }
  };

  window.addEventListener("storage", storageEventCallback);

  return () => {
    window.removeEventListener("storage", storageEventCallback);
  };
};

export const useMeterSettingsStore = create<MeterSettings & MeterStateFunctions>()(
  persist(
    (set) => ({
      ...DEFAULT_METER_SETTINGS,
      set: (settings) => {
        set(settings);
        if (!applyingRemoteSettings && insideTauri()) void emit(SETTINGS_SYNC_EVENT, settings);
      },
    }),
    {
      name: "meter-settings",
      version: 2,
      // v2 changed column lists from an ordered array of *shown* columns
      // (string[]) to the full set of columns each tagged visible/hidden
      // (ColumnSetting[]), so hiding a column keeps its position. Convert any
      // legacy string[] into that shape. (v1 removed the "damage-cap" and
      // player-row "overcap" columns — still stripped here for player lists.)
      migrate: (persisted) => {
        const state = { ...(persisted as Record<string, unknown>) };

        // Player rows dropped these columns in v1; never resurrect them.
        const removedPlayer = ["damage-cap", "overcap"];

        const convert = <T extends string>(
          raw: unknown,
          universe: T[],
          removed: string[] = []
        ): ColumnSetting<T>[] | undefined => {
          if (!Array.isArray(raw)) return undefined; // absent → let the default fill it in
          if (raw.length > 0 && typeof raw[0] === "object") return raw as ColumnSetting<T>[]; // already migrated
          const shown = (raw as unknown[]).filter(
            (column): column is T =>
              typeof column === "string" && (universe as string[]).includes(column) && !removed.includes(column)
          );
          return buildColumns(universe, shown);
        };

        const overlay = convert(state.overlay_columns, ALL_METER_COLUMNS, removedPlayer);
        if (overlay) state.overlay_columns = overlay;
        const overlaySkill = convert(state.overlay_skill_columns, ALL_SKILL_COLUMNS);
        if (overlaySkill) state.overlay_skill_columns = overlaySkill;
        const logs = convert(state.logs_columns, ALL_METER_COLUMNS, removedPlayer);
        if (logs) state.logs_columns = logs;
        const logsSkill = convert(state.logs_skill_columns, ALL_SKILL_COLUMNS);
        if (logsSkill) state.logs_skill_columns = logsSkill;

        return state as unknown as MeterSettings & MeterStateFunctions;
      },
      // Runs on EVERY hydration (unlike `migrate`, which only fires on a version
      // change): reconcile each persisted column list against the current column
      // universe so a column added in a later release always becomes reachable in
      // the picker — even for a user whose stored list predates it and whose
      // version already matches. Also prunes columns that left the universe.
      merge: (persisted, current) => {
        const merged = { ...current, ...((persisted ?? {}) as Partial<MeterSettings>) };
        const removedPlayer = ["damage-cap", "overcap"];

        // A persisted list should already be ColumnSetting[] (post-migrate), but
        // fall back to the default if it's malformed/absent so reconcile always
        // gets a valid list.
        const settingsOr = <T extends string>(raw: unknown, fallback: ColumnSetting<T>[]): ColumnSetting<T>[] =>
          Array.isArray(raw) && raw.every((c) => c != null && typeof c === "object" && "id" in c)
            ? (raw as ColumnSetting<T>[])
            : fallback;

        merged.overlay_columns = reconcileColumns(
          settingsOr(merged.overlay_columns, DEFAULT_OVERLAY_COLUMNS),
          ALL_METER_COLUMNS,
          removedPlayer
        );
        merged.overlay_skill_columns = reconcileColumns(
          settingsOr(merged.overlay_skill_columns, DEFAULT_OVERLAY_SKILL_COLUMNS),
          ALL_SKILL_COLUMNS
        );
        merged.logs_columns = reconcileColumns(
          settingsOr(merged.logs_columns, DEFAULT_LOGS_COLUMNS),
          ALL_METER_COLUMNS,
          removedPlayer
        );
        merged.logs_skill_columns = reconcileColumns(
          settingsOr(merged.logs_skill_columns, DEFAULT_LOGS_SKILL_COLUMNS),
          ALL_SKILL_COLUMNS
        );

        return merged;
      },
    }
  )
);

withStorageDOMEvents(useMeterSettingsStore);

if (insideTauri()) {
  void listen<Partial<MeterSettings>>(SETTINGS_SYNC_EVENT, (event) => {
    applyingRemoteSettings = true;
    try {
      useMeterSettingsStore.getState().set(event.payload);
    } finally {
      applyingRemoteSettings = false;
    }
  });

  void listen<string>(LANGUAGE_SYNC_EVENT, (event) => {
    if (window.i18n && window.i18n.language !== event.payload) {
      window.i18n.changeLanguage(event.payload);
    }
  });
}
