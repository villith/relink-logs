import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMeterSettingsStore } from "../stores/useMeterSettingsStore";
import {
  ComputedPlayerState,
  EncounterState,
  LegalityFinding,
  MeterColumns,
  PlayerData,
  SortDirection,
  SortType,
  visibleColumns,
} from "../types";
import { formatInPartyOrder, meterGridTemplate, sortPlayers } from "../utils";
import { PlayerRow } from "./PlayerRow";

export const Table = ({
  live = false,
  encounterState,
  partyData,
  sortType,
  sortDirection,
  setSortType,
  setSortDirection,
  legality,
}: {
  live?: boolean;
  encounterState: EncounterState;
  partyData: Array<PlayerData | null>;
  /** Build-legality findings per party slot, aligned with `partyData`. */
  legality?: LegalityFinding[][];
  sortType: SortType;
  sortDirection: SortDirection;
  setSortType: (sortType: SortType) => void;
  setSortDirection: (sortDirection: SortDirection) => void;
}) => {
  const { t } = useTranslation();
  const { streamerMode, show_full_values, overlay_columns, logs_columns, barFillMode, barTexture, barHeight, barGap } =
    useMeterSettingsStore(
      useShallow((state) => ({
        useCondensedSkills: state.use_condensed_skills,
        streamerMode: state.streamer_mode,
        show_full_values: state.show_full_values,
        overlay_columns: state.overlay_columns,
        logs_columns: state.logs_columns,
        barFillMode: state.bar_fill_mode,
        barTexture: state.bar_texture,
        barHeight: state.bar_height,
        barGap: state.bar_spacing,
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

  // Taken AFTER the streamer-mode filter: with only the streamer's own row on
  // screen, a relative bar that always reads 100% is the intended result.
  const maxPercentage = players.reduce((max, player) => Math.max(max, player.percentage || 0), 0);

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
    // The bar custom properties are set on the OUTER table and inherit down the
    // DOM, so the nested skill-breakdown table picks them up with no wiring of
    // its own.
    //
    // Divs with explicit ARIA roles rather than a <table>: the damage bar is a
    // row background, and table cells paint backgrounds in ways engines
    // disagree about — see the note above `.table` in App.css. The roles keep
    // the semantics a table gave for free.
    <div
      role="table"
      className={`player-table table w-full bar-texture-${barTexture} ${show_full_values ? "full-values" : ""}`}
      style={
        {
          "--meter-row-height": `${barHeight}px`,
          "--meter-row-gap": `${barGap}px`,
          // One template shared by the header and every row, so the columns
          // cannot drift apart. Built here because only this component knows how
          // many value columns the user has chosen; the widths stay variables so
          // the narrow rules can retune them.
          "--meter-grid": meterGridTemplate(columns.length),
        } as CSSProperties
      }
    >
      <div className="header transparent-bg" role="rowgroup">
        <div className="meter-row" role="row">
          <div className="header-name" role="columnheader" onClick={() => toggleSort(MeterColumns.Name)}>
            {t("ui.meter-columns.name")}
          </div>
          {columns.map((column) => (
            <div
              key={column}
              role="columnheader"
              className={`header-column header-column-${column} text-center`}
              onClick={() => toggleSort(column)}
            >
              {t(`ui.meter-columns.${column}`)}
            </div>
          ))}
        </div>
      </div>
      <div className="table-body" role="rowgroup">
        {players.map((player, rank) => (
          <PlayerRow
            live={live}
            key={player.index}
            rank={rank}
            player={player}
            partyData={partyData}
            durationSeconds={durationSeconds}
            legality={legality}
            maxPercentage={maxPercentage}
            fillMode={barFillMode}
          />
        ))}
      </div>
    </div>
  );
};
