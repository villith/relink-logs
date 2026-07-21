import { DeathEvent, EncounterState, HpChartSeries, PlayerData, SBAEvent, TargetEntry, TargetSpan } from "@/types";
import { create } from "zustand";

interface EncounterStore {
  encounterState: EncounterState | null;
  dpsChart: Record<number, number[]>;
  /** Enemy HP% per second, one series per charted HP pool (largest first). Empty on old logs. */
  hpChart: HpChartSeries[];
  sbaChart: Record<number, number[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  /** Per-spawn selectable targets, first-hit order. */
  targetEntries: TargetEntry[];
  /** Selected target spawn spans; empty = all. */
  selectedTargetSpans: TargetSpan[];
  selectedPlayers: string[];
  players: PlayerData[];
  questId: number | null;
  questTimer: number | null;
  questCompleted: boolean;
  /** 0-based room index when this log is a Conflux room, else null. */
  roomIndex: number | null;
  setSelectedTargetSpans: (targetSpans: TargetSpan[]) => void;
  setSelectedPlayers: (playerNames: string[]) => void;
  loadFromResponse: (response: EncounterStateResponse) => void;
}

export interface EncounterStateResponse {
  encounterState: EncounterState;
  dpsChart: Record<number, number[]>;
  hpChart: HpChartSeries[];
  sbaChart: Record<number, number[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  targetEntries: TargetEntry[];
  players: PlayerData[];
  questId: number | null;
  questTimer: number | null;
  questCompleted: boolean | null;
  roomIndex: number | null;
}

export const useEncounterStore = create<EncounterStore>((set) => ({
  encounterState: null,
  dpsChart: {},
  hpChart: [],
  sbaChart: {},
  sbaEvents: [],
  deathEvents: [],
  chartLen: 0,
  sbaChartLen: 0,
  targetEntries: [],
  selectedTargetSpans: [],
  selectedPlayers: [],
  players: [],
  questId: null,
  questTimer: null,
  questCompleted: false,
  roomIndex: null,
  setSelectedTargetSpans: (targetSpans: TargetSpan[]) => set({ selectedTargetSpans: targetSpans }),
  setSelectedPlayers: (playerNames: string[]) => set({ selectedPlayers: playerNames }),
  loadFromResponse: (response: EncounterStateResponse) => {
    const filteredPlayers = response.players.filter((player) => player !== null);

    set({
      encounterState: response.encounterState,
      dpsChart: response.dpsChart,
      hpChart: response.hpChart ?? [],
      sbaChart: response.sbaChart,
      sbaEvents: response.sbaEvents,
      deathEvents: response.deathEvents,
      chartLen: response.chartLen,
      sbaChartLen: response.sbaChartLen,
      targetEntries: response.targetEntries ?? [],
      players: filteredPlayers,
      questId: response.questId,
      questTimer: response.questTimer,
      questCompleted: response.questCompleted || false,
      roomIndex: response.roomIndex,
    });
  },
}));
