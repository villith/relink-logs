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

/** How a row's bar is sized. `total`: the width is the row's share of the whole.
 * `relative`: the largest row fills its bar and the rest scale against it, which
 * makes differences between the middle rows readable. Affects the painted bar
 * ONLY — the percentage column is always a true share, because that one is data. */
export type BarFillMode = "total" | "relative";

/** One piece of the overlay header. Rendered as its own `.item` div, so it keeps
 * the CSS dot separator and the Tauri drag region; a segment whose template
 * renders empty is not rendered at all, which is what makes team damage and boss
 * HP appear only once they have something to report. */
export type HeaderSegment = {
  id: string;
  side: "left" | "right";
  template: string;
  /** Dropped on very narrow overlays, where the window buttons need the room. */
  hideWhenNarrow: boolean;
};

/** Built-in bar textures. Stored as a plain string rather than a union so a
 * future user-supplied source (`file:…`) needs no settings migration. */
export const BAR_TEXTURES = ["solid", "smooth", "gloss", "glaze", "charcoal", "fade", "striped"] as const;

export const DEFAULT_PLAYER_LABEL = "[{slot}] {name} ({character})";

/**
 * The overlay header's action buttons, in the order they are drawn.
 *
 * Minimize is deliberately absent: it is always shown, so an overlay can never
 * be configured into a state where there is no way to get it out of the way.
 */
export const HEADER_BUTTONS = ["clipboard", "pin", "screenshot", "reset"] as const;
export type HeaderButtonId = (typeof HEADER_BUTTONS)[number];
export type HeaderButtonVisibility = Record<HeaderButtonId, boolean>;

export const DEFAULT_HEADER_BUTTONS: HeaderButtonVisibility = {
  clipboard: true,
  pin: true,
  screenshot: true,
  reset: true,
};

/** The overlay's starting size, matching the `main` window in tauri.conf.json —
 * the two must agree or the overlay would jump on first launch. */
export const DEFAULT_OVERLAY_SIZE = { overlay_width: 500, overlay_height: 350 };

/** Floors from the `main` window's minWidth/minHeight. Going under them lets the
 * user shrink the overlay past what the window itself accepts, so the stored
 * number and the real window would silently disagree. */
export const OVERLAY_MIN_SIZE = { width: 250, height: 120 };

/** Seeded to reproduce the header exactly as it read before it was customizable. */
export const DEFAULT_HEADER_SEGMENTS: HeaderSegment[] = [
  { id: "brand", side: "left", template: "{app} {version}", hideWhenNarrow: false },
  { id: "damage", side: "left", template: "{damage}", hideWhenNarrow: true },
  { id: "dps", side: "left", template: "{dps}/s", hideWhenNarrow: true },
  { id: "hp", side: "left", template: "HP {hpPercent} ({hpCurrent} / {hpMax})", hideWhenNarrow: true },
  { id: "status", side: "right", template: "{status}", hideWhenNarrow: false },
];

interface MeterSettings {
  color_1: string;
  color_2: string;
  color_3: string;
  color_4: string;
  transparency: number;
  show_display_names: boolean;
  streamer_mode: boolean;
  /** Show build-audit verdicts anywhere outside the Build Audit page itself —
   * the quest list, a log's Equipment and Builds tabs, and the meter.
   *
   * Off by default, and the master switch the narrower ones sit under. Naming
   * someone a cheater is an accusation the app should not make on a user's
   * behalf until they ask for it; the Build Audit page is where someone goes
   * deliberately to look, so it is the one surface this does not gate. */
  show_flagged_builds: boolean;
  /** Colour a player's name in the meter when the build audit flags their
   * equipment. A coloured name in an always-on-top overlay is a public
   * accusation, so it is a choice — and it is suppressed under streamer_mode,
   * where names are hidden anyway. Only has effect while
   * `show_flagged_builds` is on. */
  highlight_illegal_builds: boolean;
  show_full_values: boolean;
  use_condensed_skills: boolean;
  /** Count Primal Burst damage toward the meters. Off by default: whether a
   * Primal Burst belongs in a DPS number is still an open question, so the app
   * leaves it out until the user says otherwise. Mirrors the backend's
   * `MeterFilters.includePrimalBurst`, which is what actually does the
   * filtering — this is only the switch. */
  include_primal_burst: boolean;
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
  /** Template for the meter's player-name cell. See src/labelTemplate.ts. */
  player_label_template: string;
  /** The overlay header, as an ordered list of independently-templated pieces. */
  header_segments: HeaderSegment[];
  /** Which of the header's action buttons are drawn. */
  header_buttons: HeaderButtonVisibility;
  /** The overlay window's size in logical pixels. The overlay applies these to
   * itself and writes back whatever the user drags it to, so the numbers on the
   * settings page and the window on screen stay the same thing. */
  overlay_width: number;
  overlay_height: number;
  bar_fill_mode: BarFillMode;
  bar_texture: string;
  /** Meter row height in px. */
  bar_height: number;
  /** Vertical gap between meter rows in px. */
  bar_spacing: number;
}

interface MeterStateFunctions {
  set: (settings: Partial<MeterSettings>) => void;
}

/** The four default party-slot colours, in slot order. Exported so the settings
 * page can offer a reset without restating them. */
export const DEFAULT_METER_COLORS = ["#FF5630", "#F2D90A", "#36B37E", "#00B8D9"] as const;

/** Default bar geometry, exported so the settings page can offer a reset
 * without restating the numbers. */
export const DEFAULT_BAR_APPEARANCE = {
  bar_fill_mode: "total" as BarFillMode,
  bar_texture: "solid",
  bar_height: 27,
  bar_spacing: 0,
};

const DEFAULT_METER_SETTINGS: MeterSettings = {
  color_1: DEFAULT_METER_COLORS[0],
  color_2: DEFAULT_METER_COLORS[1],
  color_3: DEFAULT_METER_COLORS[2],
  color_4: DEFAULT_METER_COLORS[3],
  transparency: 0.2,
  show_display_names: true,
  streamer_mode: false,
  show_flagged_builds: false,
  highlight_illegal_builds: true,
  show_full_values: false,
  use_condensed_skills: true,
  include_primal_burst: false,
  open_log_on_save: true,
  auto_check_updates: true,
  skipped_update_version: null,
  overlay_columns: [...DEFAULT_OVERLAY_COLUMNS],
  overlay_skill_columns: [...DEFAULT_OVERLAY_SKILL_COLUMNS],
  logs_columns: [...DEFAULT_LOGS_COLUMNS],
  logs_skill_columns: [...DEFAULT_LOGS_SKILL_COLUMNS],
  player_label_template: DEFAULT_PLAYER_LABEL,
  header_segments: [...DEFAULT_HEADER_SEGMENTS],
  header_buttons: { ...DEFAULT_HEADER_BUTTONS },
  ...DEFAULT_OVERLAY_SIZE,
  ...DEFAULT_BAR_APPEARANCE,
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
