import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, MeterColumns, PlayerData } from "@/types";
import { humanizeNumbers } from "@/utils";

export type ColumnValue = {
  value: string | number;
  unit?: string | number;
};

export const usePlayerRow = (live: boolean, player: ComputedPlayerState, partyData: Array<PlayerData | null>) => {
  const { color_1, color_2, color_3, color_4, show_display_names, show_full_values, overlay_columns } =
    useMeterSettingsStore(
      useShallow((state) => ({
        color_1: state.color_1,
        color_2: state.color_2,
        color_3: state.color_3,
        color_4: state.color_4,
        show_display_names: state.show_display_names,
        show_full_values: state.show_full_values,
        overlay_columns: state.overlay_columns,
      }))
    );

  const [isOpen, setIsOpen] = useState(false);

  const playerColors = [color_1, color_2, color_3, color_4, "#9BCF53", "#380E7F", "#416D19", "#2C568D"];
  const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);
  // A filled party slot's color belongs to the row matched to it. A row that doesn't
  // resolve to a slot picks, by its sort position, from the remaining colors: first
  // the EMPTY slots' colors (so four characters still use colors 1-4 even when some
  // identities are missing), then the overflow colors. Indexing the slot palette by
  // partyIndex (an arbitrary sort position) collided with matched rows' colors.
  const freeColors = playerColors.filter((_, i) => i >= 4 || !partyData[i]);
  const color =
    partySlotIndex !== -1 ? playerColors[partySlotIndex] : freeColors[player.partyIndex % freeColors.length];

  const [totalDamage, totalDamageUnit] = humanizeNumbers(player.totalDamage);
  const [dps, dpsUnit] = humanizeNumbers(player.dps);
  const [totalStunValue, totalStunValueUnit] = humanizeNumbers(player.totalStunValue);

  // Percentage of this player's cap-eligible hits that reached the game's damage cap.
  // Cap-less sources (e.g. supplementary damage) are excluded from the denominator so
  // they don't dilute the percentage.
  const damageCapPercentage = player.cappableHits > 0 ? (player.cappedHits / player.cappableHits) * 100 : 0;

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
      case MeterColumns.DamageCap:
        return { value: damageCapPercentage.toFixed(0), unit: "%" };
      case MeterColumns.SBA:
        return showFullValues
          ? { value: (player.sba / 10).toFixed(2) }
          : { value: (player.sba / 10).toFixed(2), unit: "%" };
      case MeterColumns.StunPerSecond:
        return { value: (player.stunPerSecond || 0).toLocaleString() };
      case MeterColumns.TotalStunValue:
        return showFullValues
          ? { value: (player.totalStunValue || 0).toLocaleString() }
          : { value: totalStunValue, unit: totalStunValueUnit };
      default:
        return { value: "" };
    }
  };

  // If the meter is in live mode, only show the overlay columns that are enabled, otherwise show all columns.
  const columns = live
    ? overlay_columns
    : [
        MeterColumns.TotalDamage,
        MeterColumns.DPS,
        MeterColumns.TotalStunValue,
        MeterColumns.StunPerSecond,
        MeterColumns.DamageCap,
        MeterColumns.DamagePercentage,
      ];

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
