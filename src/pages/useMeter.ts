import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  EncounterState,
  EncounterUpdateEvent,
  MeterColumns,
  PartyUpdateEvent,
  PlayerData,
  SortDirection,
  SortType,
} from "@/types";
import { usePrevious } from "@mantine/hooks";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, appWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

const DEFAULT_ENCOUNTER_STATE: EncounterState = {
  totalDamage: 0,
  dps: 0,
  startTime: 0,
  endTime: 1,
  party: {},
  targets: {},
  status: "Waiting",
};

/** Overlay minimum-width model: keep the window wide enough that every visible
 * column fits without the name column collapsing to an ellipsis. The widths
 * mirror `.table .header-name` / `.header-column` in App.css — a value column
 * is 4.5rem normally and 6rem with `show_full_values` (1rem = 16px). */
const NAME_COLUMN_MIN_WIDTH = 120;
const VALUE_COLUMN_WIDTH = 72;
const VALUE_COLUMN_WIDTH_FULL = 96;
const OVERLAY_CHROME_WIDTH = 24; // window edges + scrollbar allowance
const OVERLAY_MIN_HEIGHT = 120; // matches tauri.conf.json main.minHeight

/** Minimum overlay width for a given set of visible value columns. */
const overlayMinWidth = (columnCount: number, showFullValues: boolean): number => {
  const valueColumnWidth = showFullValues ? VALUE_COLUMN_WIDTH_FULL : VALUE_COLUMN_WIDTH;
  return NAME_COLUMN_MIN_WIDTH + columnCount * valueColumnWidth + OVERLAY_CHROME_WIDTH;
};

export default function useMeter() {
  const { t } = useTranslation();
  const [currentTime, setCurrentTime] = useState(0);
  const [partyData, setPartyData] = useState<Array<PlayerData | null>>([null, null, null, null]);
  const [encounterState, setEncounterState] = useState<EncounterState>(DEFAULT_ENCOUNTER_STATE);
  const [lastPartyData, setLastPartyData] = useState<Array<PlayerData | null>>([null, null, null, null]);

  const previousStatus = usePrevious(encounterState.status);

  const [sortType, setSortType] = useState<SortType>(MeterColumns.TotalDamage);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const { transparency, overlayColumns, showFullValues } = useMeterSettingsStore(
    useShallow((state) => ({
      transparency: state.transparency,
      overlayColumns: state.overlay_columns,
      showFullValues: state.show_full_values,
    }))
  );

  // Grow the overlay's minimum width with the number of visible columns so that
  // adding columns can't squeeze the player/skill names into an ellipsis.
  useEffect(() => {
    void appWindow.setMinSize(
      new LogicalSize(overlayMinWidth(overlayColumns.length, showFullValues), OVERLAY_MIN_HEIGHT)
    );
  }, [overlayColumns, showFullValues]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const encounterUpdateListener = listen("encounter-update", (event: EncounterUpdateEvent) => {
      setEncounterState(event.payload);

      if (event.payload.status === "InProgress" && encounterState.status === "Waiting") {
        encounterState.startTime == Date.now();
      }
    });

    const encounterSavedListener = listen("encounter-saved", () => {
      toast.success(t("ui.successful-save"));
    });

    const encounterSavedErrorListener = listen("encounter-saved-error", (evt) => {
      toast.error(t("ui.unsuccessful-save", { error: evt.payload }));
    });

    const onAreaEnterListener = listen("on-area-enter", (event: EncounterUpdateEvent) => {
      if (event.payload.status === "Waiting") {
        setEncounterState(DEFAULT_ENCOUNTER_STATE);
      } else {
        setEncounterState(event.payload);
      }

      toast.success(t("ui.on-area-enter"));
    });

    const onPartyUpdate = listen("encounter-party-update", (event: PartyUpdateEvent) => {
      setPartyData(event.payload);
    });

    const onSuccessAlert = listen("success-alert", (evt) => {
      toast.success(evt.payload as string);
    });

    const onErrorAlert = listen("error-alert", (evt) => {
      toast.error(evt.payload as string);
    });

    const onPinned = listen("on-pinned", (evt) => {
      evt.payload ? toast.success(t("ui.on-pin-enabled")) : toast.success(t("ui.on-pin-disabled"));
    });

    const onClickthrough = listen("on-clickthrough", (evt) => {
      evt.payload ? toast.success(t("ui.on-clickthrough-enabled")) : toast.success(t("ui.on-clickthrough-disabled"));
    });

    return () => {
      encounterUpdateListener.then((f) => f());
      encounterSavedListener.then((f) => f());
      encounterSavedErrorListener.then((f) => f());
      onAreaEnterListener.then((f) => f());
      onPartyUpdate.then((f) => f());
      onSuccessAlert.then((f) => f());
      onErrorAlert.then((f) => f());
      onPinned.then((f) => f());
      onClickthrough.then((f) => f());
    };
  }, [partyData]);

  useEffect(() => {
    if (previousStatus === "InProgress" && encounterState.status === "Stopped") {
      setLastPartyData(partyData);
    }
  }, [previousStatus, encounterState.status, partyData]);

  const elapsedTime = Math.max(currentTime - encounterState.startTime, 0);

  return {
    encounterState,
    partyData,
    lastPartyData,
    elapsedTime,
    sortType,
    setSortType,
    sortDirection,
    setSortDirection,
    transparency,
  };
}
