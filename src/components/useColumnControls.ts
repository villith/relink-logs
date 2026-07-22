import { DropResult } from "@hello-pangea/dnd";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ColumnSetting } from "@/types";

export type ColumnControls = {
  /** Every column of the set, in display order (both shown and hidden). */
  items: ColumnSetting<string>[];
  /** Flip a column's visibility, keeping its position in the list. */
  onToggle: (id: string) => void;
  onReorder: (result: DropResult) => void;
};

/** Move the item at `startIndex` to `endIndex`, returning a new array. */
export const reorderColumns = <T>(list: T[], startIndex: number, endIndex: number): T[] => {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed);
  return result;
};

/** Flip `visible` for the matching column, leaving order (and every other
 * column) untouched. */
export const toggleColumn = <T extends string>(settings: ColumnSetting<T>[], id: T): ColumnSetting<T>[] =>
  settings.map((setting) => (setting.id === id ? { ...setting, visible: !setting.visible } : setting));

type ColumnKey = "overlay_columns" | "overlay_skill_columns" | "logs_columns" | "logs_skill_columns";

/** Builds reorder/toggle controllers for each persisted column list. Shared by
 * the overlay settings and the quest-details columns popover. */
export const useColumnControls = () => {
  const { overlay_columns, overlay_skill_columns, logs_columns, logs_skill_columns, setMeterSettings } =
    useMeterSettingsStore(
      useShallow((state) => ({
        overlay_columns: state.overlay_columns,
        overlay_skill_columns: state.overlay_skill_columns,
        logs_columns: state.logs_columns,
        logs_skill_columns: state.logs_skill_columns,
        setMeterSettings: state.set,
      }))
    );

  const make = <T extends string>(key: ColumnKey, settings: ColumnSetting<T>[]): ColumnControls => ({
    items: settings,
    onReorder: (result) => {
      if (!result.destination) return;
      setMeterSettings({
        [key]: reorderColumns(settings, result.source.index, result.destination.index),
      } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
    onToggle: (id) => {
      setMeterSettings({ [key]: toggleColumn(settings, id as T) } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
  });

  return {
    overlayPlayer: make("overlay_columns", overlay_columns),
    overlaySkill: make("overlay_skill_columns", overlay_skill_columns),
    logsPlayer: make("logs_columns", logs_columns),
    logsSkill: make("logs_skill_columns", logs_skill_columns),
  };
};
