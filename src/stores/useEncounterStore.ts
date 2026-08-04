import {
  AbilityChartSeries,
  DeathEvent,
  EncounterState,
  HpChartSeries,
  LegalityFinding,
  PlayerData,
  SBAEvent,
  SelectionFact,
  StatusInterval,
  TakenChartSeries,
  TargetChartSeries,
  TargetEntry,
  TargetSpan,
} from "@/types";
import { create } from "zustand";

interface EncounterStore {
  encounterState: EncounterState | null;
  dpsChart: Record<number, number[]>;
  /** Stun applied per second, keyed by actor index. Empty on a backend that
   * predates the field. */
  stunChart: Record<number, number[]>;
  /** Damage TAKEN per second, keyed by the victim's slot key. Empty on a
   * backend that predates the field; all zeroes on logs recorded before
   * damage-taken capture. */
  takenChart: Record<number, number[]>;
  /** Enemy HP% per second, one series per charted HP pool (largest first). Empty on old logs. */
  hpChart: HpChartSeries[];
  /** Every window an actor held a status effect for, spanning the whole fight.
   * Empty on logs recorded before status capture. */
  statusIntervals: StatusInterval[];
  sbaChart: Record<number, number[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  /** Per-spawn selectable targets, first-hit order. */
  targetEntries: TargetEntry[];
  /** Every (source, target, ability) combination in the current window, with
   * the selector pins NOT applied — the analysis view cascades from this. */
  selectionFacts: SelectionFact[];
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
  /** Per-player damage buckets. On the base load these span the whole fight
   * unpinned; on a scoped fetch with NO source pinned they are rebuilt under the
   * enemy and ability pins, so the analysis chart narrows with its table. Empty
   * on a scoped fetch that pinned a source — the drill charts answer there. */
  dpsChart: Record<number, number[]>;
  /** Optional so a backend older than the field reads as "no stun series". */
  stunChart?: Record<number, number[]>;
  /** Optional so a backend older than the field reads as "no taken series". */
  takenChart?: Record<number, number[]>;
  hpChart: HpChartSeries[];
  /** Optional so a backend older than the field reads as "no status capture" —
   * which is also what every log recorded before the hook emitted these has. */
  statusIntervals?: StatusInterval[];
  sbaChart: Record<number, number[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  targetEntries: TargetEntry[];
  /** Optional so a backend older than the field reads as "nothing to cascade". */
  selectionFacts?: SelectionFact[];
  /** The analysis view's drill-down chart, sent only on a scoped fetch that
   * pinned a source. Not stored: it belongs to one set of pins, and the store
   * holds the base load. Optional so a frontend ahead of its backend — the Rust
   * binary does not hot-reload — degrades to the per-player chart. */
  abilityChart?: AbilityChartSeries[];
  /** The level below: what the pinned ability hit, one band per enemy spawn. */
  targetChart?: TargetChartSeries[];
  /** The taken tab's drill bands for the pinned player — one per (attacker,
   * attack). Scoped fetches only, like the two above; not stored. */
  takenAbilityChart?: TakenChartSeries[];
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
  stunChart: {},
  takenChart: {},
  hpChart: [],
  statusIntervals: [],
  sbaChart: {},
  sbaEvents: [],
  deathEvents: [],
  chartLen: 0,
  sbaChartLen: 0,
  targetEntries: [],
  selectionFacts: [],
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
      stunChart: response.stunChart ?? {},
      takenChart: response.takenChart ?? {},
      hpChart: response.hpChart ?? [],
      statusIntervals: response.statusIntervals ?? [],
      sbaChart: response.sbaChart,
      sbaEvents: response.sbaEvents,
      deathEvents: response.deathEvents,
      chartLen: response.chartLen,
      sbaChartLen: response.sbaChartLen,
      targetEntries: response.targetEntries ?? [],
      selectionFacts: response.selectionFacts ?? [],
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
