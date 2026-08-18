import {
  AbilitySeries,
  ChartWindow,
  DeathEvent,
  EncounterState,
  GroupAggregate,
  GroupReference,
  HpChartSeries,
  LegalityFinding,
  PlayerData,
  SBAEvent,
  SelectionFact,
  StatusInterval,
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
  /** Spans a battle state held (an SBA performance, Link Time, an enemy's
   * Break), for the chart's shaded windows. Empty on logs recorded before
   * the transition events existed. */
  chartWindows: ChartWindow[];
  sbaChart: Record<number, number[]>;
  /** Per-ability bands for the DRILLED Stun/SBA chart, keyed by player index.
   * Empty unless the last fetch asked for them — an undrilled tab never does. */
  abilitySeries: Record<number, AbilitySeries[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  /** Per-spawn selectable targets, first-hit order. */
  targetEntries: TargetEntry[];
  /** Every (source, target, ability) combination in the current window, with
   * the selector pins NOT applied — the analysis view cascades from this. */
  selectionFacts: SelectionFact[];
  /** The (filters × groupBy) aggregates for the last `groupQuery` sent — table
   * rows and chart bands from ONE grouping. Empty when no query was sent. */
  groups: GroupAggregate[];
  /** The same grouping over the WHOLE fight, for the chart's band colours.
   * Empty when the query narrowed no time — then the aggregates above already
   * ARE that ranking. */
  groupReference: GroupReference[];
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
  /** Back to no fight loaded, leaving the target/player selection untouched.
   * The Classic view calls this synchronously on an id change, before its
   * fetch starts, so a log swap never renders the previous log's data under
   * the new one's breadcrumbs while the fetch is in flight. */
  resetEncounterState: () => void;
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
  /** Optional so a backend older than the field reads as "no windows". */
  chartWindows?: ChartWindow[];
  sbaChart: Record<number, number[]>;
  /** The drilled Stun/SBA chart's bands, sent only when the request carried an
   * `abilitySeries` query. Optional so a frontend ahead of its backend degrades
   * to no bands — and therefore to the per-player lines — rather than throwing. */
  abilitySeries?: Record<number, AbilitySeries[]>;
  sbaEvents: SBAEvent[];
  deathEvents: DeathEvent[];
  chartLen: number;
  sbaChartLen: number;
  targetEntries: TargetEntry[];
  /** Optional so a backend older than the field reads as "nothing to cascade". */
  selectionFacts?: SelectionFact[];
  /** The analysis view's generic aggregation, sent only when the request
   * carried a `groupQuery`. Optional so a frontend ahead of its backend
   * degrades to no groups rather than an error. */
  groups?: GroupAggregate[];
  /** Optional for the same reason as `groups`: a frontend ahead of its backend
   * degrades to ranking bands by the aggregates it was sent. */
  groupReference?: GroupReference[];
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

/** Everything a response says about a fight, normalised: absent optional fields
 * read as their empty value, and `players`/`legality` are filtered in lockstep.
 *
 * A pure function rather than logic inside the store's setter, because there are
 * now two holders of a loaded encounter — this store, which the live meter and
 * the Classic view read, and an analysis PANE's own slice, of which there is one
 * per compared log. Both normalise here, so a finding cannot land on the wrong
 * player in one of them and the right one in the other. */
export const encounterFromResponse = (response: EncounterStateResponse): EncounterFacts => {
  // Keep the two filters identical, or a finding lands on the wrong player.
  const keptSlots = response.players
    .map((player, slot) => [player, slot] as const)
    .filter(([player]) => player !== null);

  return {
    encounterState: response.encounterState,
    dpsChart: response.dpsChart,
    stunChart: response.stunChart ?? {},
    takenChart: response.takenChart ?? {},
    hpChart: response.hpChart ?? [],
    statusIntervals: response.statusIntervals ?? [],
    chartWindows: response.chartWindows ?? [],
    sbaChart: response.sbaChart,
    abilitySeries: response.abilitySeries ?? {},
    sbaEvents: response.sbaEvents,
    deathEvents: response.deathEvents,
    chartLen: response.chartLen,
    sbaChartLen: response.sbaChartLen,
    targetEntries: response.targetEntries ?? [],
    selectionFacts: response.selectionFacts ?? [],
    groups: response.groups ?? [],
    groupReference: response.groupReference ?? [],
    players: keptSlots.map(([player]) => player),
    legality: keptSlots.map(([, slot]) => response.legality?.[slot] ?? []),
    questId: response.questId,
    questTimer: response.questTimer,
    questCompleted: response.questCompleted || false,
    roomIndex: response.roomIndex,
    imported: response.imported ?? false,
  };
};

/** The normalised half of the store — what a loaded response says, with none of
 * the selection state or the setters. */
export type EncounterFacts = Omit<
  EncounterStore,
  | "selectedTargetSpans"
  | "selectedPlayers"
  | "setSelectedTargetSpans"
  | "setSelectedPlayers"
  | "loadFromResponse"
  | "resetEncounterState"
>;

/** No fight loaded. Exported and shared with the store's own initial state so
 * "empty" has one definition — and so a pane still waiting on its fetch hands
 * the same stable empty arrays to its memos on every render rather than fresh
 * literals that rebuild the whole view. */
export const EMPTY_ENCOUNTER_FACTS: EncounterFacts = {
  encounterState: null,
  dpsChart: {},
  stunChart: {},
  takenChart: {},
  hpChart: [],
  statusIntervals: [],
  chartWindows: [],
  sbaChart: {},
  abilitySeries: {},
  sbaEvents: [],
  deathEvents: [],
  chartLen: 0,
  sbaChartLen: 0,
  targetEntries: [],
  selectionFacts: [],
  groups: [],
  groupReference: [],
  players: [],
  legality: [],
  questId: null,
  questTimer: null,
  questCompleted: false,
  roomIndex: null,
  imported: false,
};

export const useEncounterStore = create<EncounterStore>((set) => ({
  ...EMPTY_ENCOUNTER_FACTS,
  selectedTargetSpans: [],
  selectedPlayers: [],
  setSelectedTargetSpans: (targetSpans: TargetSpan[]) => set({ selectedTargetSpans: targetSpans }),
  setSelectedPlayers: (playerNames: string[]) => set({ selectedPlayers: playerNames }),
  loadFromResponse: (response: EncounterStateResponse) => set(encounterFromResponse(response)),
  resetEncounterState: () => set(EMPTY_ENCOUNTER_FACTS),
}));
