import { MeterColumns } from "@/types";
import { Mutate, StoreApi, create } from "zustand";
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
  overlay_columns: MeterColumns[];
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
  overlay_columns: [
    MeterColumns.TotalDamage,
    MeterColumns.DPS,
    MeterColumns.TotalStunValue,
    MeterColumns.StunPerSecond,
    MeterColumns.SupPercentage,
    MeterColumns.DamagePercentage,
  ],
};

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
      set: (settings) => set(settings),
    }),
    {
      name: "meter-settings",
      version: 1,
      // v1 removed the "damage-cap" and (player-row) "overcap" columns. Strip them
      // from any persisted overlay_columns so old users don't get blank columns.
      migrate: (persisted) => {
        const state = persisted as MeterSettings & MeterStateFunctions;
        const removed: string[] = ["damage-cap", "overcap"];
        if (Array.isArray(state?.overlay_columns)) {
          state.overlay_columns = state.overlay_columns.filter((column) => !removed.includes(column));
        }
        return state;
      },
    }
  )
);

withStorageDOMEvents(useMeterSettingsStore);
