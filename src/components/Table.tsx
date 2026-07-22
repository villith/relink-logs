import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMeterSettingsStore } from "../stores/useMeterSettingsStore";
import {
  ComputedPlayerState,
  EncounterState,
  MeterColumns,
  PlayerData,
  SortDirection,
  SortType,
  visibleColumns,
} from "../types";
import { formatInPartyOrder, sortPlayers } from "../utils";
import { PlayerRow } from "./PlayerRow";

export const Table = ({
  live = false,
  encounterState,
  partyData,
  sortType,
  sortDirection,
  setSortType,
  setSortDirection,
}: {
  live?: boolean;
  encounterState: EncounterState;
  partyData: Array<PlayerData | null>;
  sortType: SortType;
  sortDirection: SortDirection;
  setSortType: (sortType: SortType) => void;
  setSortDirection: (sortDirection: SortDirection) => void;
}) => {
  const { t } = useTranslation();
  const { streamerMode, show_full_values, overlay_columns, logs_columns } = useMeterSettingsStore(
    useShallow((state) => ({
      useCondensedSkills: state.use_condensed_skills,
      streamerMode: state.streamer_mode,
      show_full_values: state.show_full_values,
      overlay_columns: state.overlay_columns,
      logs_columns: state.logs_columns,
    }))
  );

  const partyOrderPlayers = formatInPartyOrder(encounterState.party);
  let players: Array<ComputedPlayerState> = partyOrderPlayers.map((playerData) => {
    return {
      ...playerData,
      percentage: (playerData.totalDamage / encounterState.totalDamage) * 100,
    };
  });

  // Sort players by the selected sort type and direction
  sortPlayers(players, sortType, sortDirection);

  players = players.filter((player) => {
    const partySlotIndex = partyData.findIndex((partyMember) => partyMember?.actorIndex === player.index);

    // If streamer mode is ON, then only show the first party slot (the streamer's character)
    // Otherwise, show all players.
    return streamerMode ? partySlotIndex === 0 : true;
  });

  // Encounter duration in seconds — the same span (last damage − first damage)
  // the parser divides by for player.stunPerSecond, so per-skill SPS stays
  // consistent with the player row. Live: grows with the fight. Logs: fixed.
  const durationSeconds = Math.max(0, encounterState.endTime - encounterState.startTime) / 1000;

  const toggleSort = (newSortType: SortType) => {
    if (sortType === newSortType) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortType(newSortType);
      setSortDirection("asc");
    }
  };

  // If the meter is live, show the overlay columns; otherwise the logs columns.
  // Memoized: the source lists are stable store refs, so this only recomputes
  // when the user edits columns — not on every meter tick.
  const columns = useMemo(
    () => visibleColumns(live ? overlay_columns : logs_columns),
    [live, overlay_columns, logs_columns]
  );

  return (
    <table className={`player-table table w-full ${show_full_values ? "full-values" : ""}`}>
      <thead className="header transparent-bg">
        <tr>
          <th className="header-name" onClick={() => toggleSort(MeterColumns.Name)}>
            Name
          </th>
          {columns.map((column) => (
            <th
              key={column}
              className={`header-column header-column-${column} text-center`}
              onClick={() => toggleSort(column)}
            >
              {t(`ui.meter-columns.${column}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {players.map((player) => (
          <PlayerRow
            live={live}
            key={player.index}
            player={player}
            partyData={partyData}
            durationSeconds={durationSeconds}
          />
        ))}
      </tbody>
    </table>
  );
};
