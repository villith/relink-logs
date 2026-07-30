import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import {
  EncounterState,
  EncounterUpdateEvent,
  LegalityFinding,
  MeterColumns,
  PartyUpdateEvent,
  PlayerData,
  SortDirection,
  SortType,
} from "@/types";
import { usePrevious } from "@mantine/hooks";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
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
  status: "Stopped",
};

export default function useMeter() {
  const { t } = useTranslation();
  const [currentTime, setCurrentTime] = useState(0);
  const [partyData, setPartyData] = useState<Array<PlayerData | null>>([null, null, null, null]);
  const [encounterState, setEncounterState] = useState<EncounterState>(DEFAULT_ENCOUNTER_STATE);
  const [lastPartyData, setLastPartyData] = useState<Array<PlayerData | null>>([null, null, null, null]);
  // Build-legality findings per party slot. A live fight has no stored row to
  // read verdicts from, so the backend derives them and pushes them alongside
  // the party update.
  const [legality, setLegality] = useState<LegalityFinding[][]>([[], [], [], []]);
  const [lastLegality, setLastLegality] = useState<LegalityFinding[][]>([[], [], [], []]);

  const previousStatus = usePrevious(encounterState.status);

  // Read through a ref so the listener effect below can register once and never
  // re-run: a language change still reaches the toasts, but does not re-register.
  const tRef = useRef(t);
  tRef.current = t;

  const [sortType, setSortType] = useState<SortType>(MeterColumns.TotalDamage);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const { transparency } = useMeterSettingsStore(
    useShallow((state) => ({
      transparency: state.transparency,
    }))
  );

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
    });

    const encounterSavedListener = listen("encounter-saved", () => {
      toast.success(tRef.current("ui.successful-save"));
    });

    const encounterSavedErrorListener = listen("encounter-saved-error", (evt) => {
      toast.error(tRef.current("ui.unsuccessful-save", { error: evt.payload }));
    });

    const onAreaEnterListener = listen("on-area-enter", (event: EncounterUpdateEvent) => {
      // A finished fight (has damage) stays on screen; an idle area reset (no
      // damage) blanks the overlay back to the default.
      setEncounterState(event.payload.totalDamage > 0 ? event.payload : DEFAULT_ENCOUNTER_STATE);
      toast.success(tRef.current("ui.on-area-enter"));
    });

    const onPartyUpdate = listen("encounter-party-update", (event: PartyUpdateEvent) => {
      setPartyData(event.payload);
    });

    const onLegalityUpdate = listen("encounter-legality-update", (event: { payload: LegalityFinding[][] }) => {
      setLegality(event.payload);
    });

    const onSuccessAlert = listen("success-alert", (evt) => {
      toast.success(evt.payload as string);
    });

    const onErrorAlert = listen("error-alert", (evt) => {
      toast.error(evt.payload as string);
    });

    const onPinned = listen("on-pinned", (evt) => {
      evt.payload
        ? toast.success(tRef.current("ui.on-pin-enabled"))
        : toast.success(tRef.current("ui.on-pin-disabled"));
    });

    const onClickthrough = listen("on-clickthrough", (evt) => {
      evt.payload
        ? toast.success(tRef.current("ui.on-clickthrough-enabled"))
        : toast.success(tRef.current("ui.on-clickthrough-disabled"));
    });

    return () => {
      encounterUpdateListener.then((f) => f());
      encounterSavedListener.then((f) => f());
      encounterSavedErrorListener.then((f) => f());
      onAreaEnterListener.then((f) => f());
      onPartyUpdate.then((f) => f());
      onLegalityUpdate.then((f) => f());
      onSuccessAlert.then((f) => f());
      onErrorAlert.then((f) => f());
      onPinned.then((f) => f());
      onClickthrough.then((f) => f());
    };
    // Deliberately NOT keyed on partyData: none of these handlers read it, the
    // backend emits `encounter-party-update` once per damage hit, and Tauri v1's
    // `listen` leaks a `window._<uid>` closure per call that `unlisten` never
    // removes (transformCallback only deletes it for `once` callbacks). Keying
    // on party data re-registered all nine at combat rate, and each leaked
    // closure pinned that render's party + encounter state -- ~275k leaked
    // callbacks and ~700MB of WebView2 growth over 70 minutes of combat.
    // `t` is read through tRef so even a language change cannot re-register.
  }, []);

  useEffect(() => {
    if (previousStatus === "InProgress" && encounterState.status === "Stopped") {
      setLastPartyData(partyData);
      // Frozen with the party it describes: the finished fight stays on screen
      // and its colours must stay with it.
      setLastLegality(legality);
    }
  }, [previousStatus, encounterState.status, partyData, legality]);

  const elapsedTime = Math.max(currentTime - encounterState.startTime, 0);

  return {
    encounterState,
    partyData,
    lastPartyData,
    legality,
    lastLegality,
    elapsedTime,
    sortType,
    setSortType,
    sortDirection,
    setSortDirection,
    transparency,
  };
}
