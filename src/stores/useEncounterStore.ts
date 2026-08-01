import {
  DeathEvent,
  EncounterState,
  HpChartSeries,
  LegalityFinding,
  PlayerData,
  SBAEvent,
  TargetEntry,
  TargetSpan,
} from "@/types";
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
  /** Stored build-legality findings, filtered in lockstep with `players` so the
   * two line up by index. The response arrives keyed by PARTY SLOT, but
   * `players` drops empty slots, so it is realigned on load rather than left
   * for every consumer to remember. */
  legality: LegalityFinding[][];
  questId: number | null;
  questTimer: number | null;
  questCompleted: boolean;
  /** 0-based room index when this log is a Conflux room, else null. */
  roomIndex: number | null;
  /** Copied in from another installation's logs.db — may lack data the source
   * app never recorded, so the detail view marks it. */
  imported: boolean;
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
  /** One vector per PARTY SLOT (0-3), parallel to the unfiltered `players`. */
  legality: LegalityFinding[][];
  questId: number | null;
  questTimer: number | null;
  questCompleted: boolean | null;
  roomIndex: number | null;
  /** Optional so a backend older than the field reads as "not imported". */
  imported?: boolean;
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
  legality: [],
  questId: null,
  questTimer: null,
  questCompleted: false,
  roomIndex: null,
  imported: false,
  setSelectedTargetSpans: (targetSpans: TargetSpan[]) => set({ selectedTargetSpans: targetSpans }),
  setSelectedPlayers: (playerNames: string[]) => set({ selectedPlayers: playerNames }),
  loadFromResponse: (response: EncounterStateResponse) => {
    // Keep the two filters identical, or a finding lands on the wrong player.
    const keptSlots = response.players
      .map((player, slot) => [player, slot] as const)
      .filter(([player]) => player !== null);
    const filteredPlayers = keptSlots.map(([player]) => player);
    const filteredLegality = keptSlots.map(([, slot]) => response.legality?.[slot] ?? []);

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
      legality: filteredLegality,
      questId: response.questId,
      questTimer: response.questTimer,
      questCompleted: response.questCompleted || false,
      roomIndex: response.roomIndex,
      imported: response.imported ?? false,
    });
  },
}));
