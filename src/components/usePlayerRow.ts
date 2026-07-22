import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, MeterColumns, PlayerData, visibleColumns } from "@/types";
import { PLAYER_COLORS, computeSupPercentage, humanizeNumbers, resolvePlayerColor } from "@/utils";

export type ColumnValue = {
  value: string | number;
  unit?: string | number;
};

export const usePlayerRow = (live: boolean, player: ComputedPlayerState, partyData: Array<PlayerData | null>) => {
  const { color_1, color_2, color_3, color_4, show_display_names, show_full_values, overlay_columns, logs_columns } =
    useMeterSettingsStore(
      useShallow((state) => ({
        color_1: state.color_1,
        color_2: state.color_2,
        color_3: state.color_3,
        color_4: state.color_4,
        show_display_names: state.show_display_names,
        show_full_values: state.show_full_values,
        overlay_columns: state.overlay_columns,
        logs_columns: state.logs_columns,
      }))
    );

  const [isOpen, setIsOpen] = useState(false);

  const playerColors = [color_1, color_2, color_3, color_4, ...PLAYER_COLORS.slice(4)];
  const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);
  const color = resolvePlayerColor(playerColors, partyData, partySlotIndex, player.partyIndex);

  const [totalDamage, totalDamageUnit] = humanizeNumbers(player.totalDamage);
  const [dps, dpsUnit] = humanizeNumbers(player.dps);
  const [totalStunValue, totalStunValueUnit] = humanizeNumbers(player.totalStunValue);

  // Function for matching the column type to the value to display in the table.
  const matchColumnTypeToValue = (showFullValues: boolean, column: MeterColumns): ColumnValue => {
    switch (column) {
      case MeterColumns.TotalDamage:
        return showFullValues
          ? { value: (player.totalDamage || 0).toLocaleString() }
          : { value: totalDamage, unit: totalDamageUnit };
      case MeterColumns.DPS:
        return showFullValues ? { value: (player.dps || 0).toLocaleString() } : { value: dps, unit: dpsUnit };
      case MeterColumns.DamagePercentage:
        return { value: (player.percentage || 0).toFixed(0), unit: "%" };
      case MeterColumns.SupPercentage: {
        // Extra damage gained from supplementary-type procs (sigil + echoes): +0% to
        // +60% of supp-eligible damage. Computed lazily so the skill-breakdown scan
        // only runs when the column is actually shown.
        const supPercentage = computeSupPercentage(player);
        return {
          value: `+${supPercentage.eligible.toFixed(0)}`,
          unit: "%",
        };
      }
      case MeterColumns.SBA:
        return showFullValues
          ? { value: (player.sba / 10).toFixed(2) }
          : { value: (player.sba / 10).toFixed(2), unit: "%" };
      case MeterColumns.StunPerSecond:
        return { value: (player.stunPerSecond || 0).toFixed(2) };
      case MeterColumns.TotalStunValue:
        return showFullValues
          ? { value: (player.totalStunValue || 0).toLocaleString() }
          : { value: totalStunValue, unit: totalStunValueUnit };
      default:
        return { value: "" };
    }
  };

  // If the meter is live, show the overlay columns; otherwise the logs columns.
  // Memoized: the source lists are stable store refs, so this only recomputes
  // when the user edits columns — not on every meter tick.
  const columns = useMemo(
    () => visibleColumns(live ? overlay_columns : logs_columns),
    [live, overlay_columns, logs_columns]
  );

  return {
    columns,
    isOpen,
    setIsOpen,
    color,
    matchColumnTypeToValue,
    partySlotIndex,
    showFullValues: show_full_values,
    showDisplayNames: show_display_names,
  };
};
