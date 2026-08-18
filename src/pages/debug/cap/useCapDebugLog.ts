import { invoke } from "@tauri-apps/api";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AbilityLabelPlayer } from "@/pages/logs/view/analysis/abilityLabel";
import { amplifyStatusIds } from "@/pages/logs/view/events/damageExplain";
import type { EncounterStateResponse } from "@/stores/useEncounterStore";
import type { ChartWindow, EventPage, Log, PlayerCapUp, PlayerData } from "@/types";

import { browsableHits, type CapDebugHit } from "./capHits";

/** How many events one fetch asks for. The same ceiling the Events tab uses, so
 * a log that reads as complete there reads as complete here. */
const EVENT_FETCH_CAP = 50_000;

/** How many recent logs the picker offers. A dev tool browsing recent captures
 * does not need the paging the real log index has. */
const RECENT_LOGS = 100;

export type CapDebugLog = {
  hits: CapDebugHit[];
  /** The party, in slot order, minus the empty slots. */
  players: PlayerData[];
  /** Each party member's per-character skill breakdown, keyed by actor index —
   * what the analysis view's `abilityLabelFor` needs to turn an action id into
   * a skill name. Action ids are per character, so this must be looked up for
   * the player who actually landed the hit. */
  skillsByActor: Map<number, AbilityLabelPlayer>;
  /** Captured cap-up records, keyed by the same actor index a hit's
   * `sourceIndex` carries. */
  capUp: Record<string, PlayerCapUp>;
  /** Status ids this log applied with an Amplify status class — feeds the
   * damage panel's post-cap held-status rows. */
  amplifyStatusIds: Set<number>;
  /** This fight's Overdrive/Break/SBA/Link spans — what the damage panel
   * joins a hit's target and moment against for the window-inferred
   * Overdrive/Break verdicts. Empty on an old log, same as `[]` everywhere
   * else this response ships them. */
  chartWindows: ChartWindow[];
  /** True when the fetch hit `EVENT_FETCH_CAP` — said out loud rather than
   * letting a long fight look like it simply ended early. */
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

const EMPTY: CapDebugLog = {
  hits: [],
  players: [],
  skillsByActor: new Map(),
  capUp: {},
  amplifyStatusIds: new Set(),
  chartWindows: [],
  truncated: false,
  loading: false,
  error: null,
};

/** The most recent logs, for the picker. */
export const useRecentLogs = () => {
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    invoke("fetch_logs", { page: 1, pageSize: RECENT_LOGS })
      .then((result) => setLogs((result as { logs: Log[] }).logs ?? []))
      .catch((e) => console.error("Could not list logs for the cap debugger:", e));
  }, []);

  return logs;
};

/**
 * One log's damage hits, party and cap-up records.
 *
 * Two fetches rather than one because the two facts live in different commands:
 * the event stream carries the hits and the captured cap-up records, while the
 * loadouts (and the character the ladder is keyed by) only come back with the
 * encounter state.
 *
 * Generation-counted like every other fetch in this app: both commands are
 * `#[tauri::command(async)]`, so a slow response for an old log can land after
 * a newer one and must drop itself rather than repaint the wrong log's data.
 */
export const useCapDebugLog = (id: number | null): CapDebugLog => {
  const [state, setState] = useState<CapDebugLog>(EMPTY);
  const generation = useRef(0);

  useEffect(() => {
    if (id === null) {
      setState(EMPTY);
      return;
    }
    const mine = ++generation.current;
    setState({ ...EMPTY, loading: true });

    Promise.all([
      invoke("fetch_encounter_events", { id, offset: 0, count: EVENT_FETCH_CAP }),
      invoke("fetch_encounter_state", { id, options: { filters: {} } }),
    ])
      .then(([eventsResult, stateResult]) => {
        if (mine !== generation.current) return;
        const page = eventsResult as EventPage;
        const encounter = stateResult as EncounterStateResponse;
        setState({
          hits: browsableHits(page.events),
          // The slot array is sparse — a three-player run has a null in it, and
          // a null slot has no loadout to itemize against.
          players: (encounter.players ?? []).filter((player): player is PlayerData => player !== null),
          // `encounterState.party` and not `players`: the skill breakdown is on
          // the computed party state, which is a different object from the
          // stored loadout even though both describe one player.
          skillsByActor: new Map(
            Object.values(encounter.encounterState?.party ?? {}).map((member) => [
              member.index,
              { characterType: member.characterType, skillBreakdown: member.skillBreakdown },
            ])
          ),
          capUp: page.capUp ?? {},
          amplifyStatusIds: amplifyStatusIds(page.events),
          chartWindows: encounter.chartWindows ?? [],
          truncated: page.total > page.events.length,
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (mine !== generation.current) return;
        setState({ ...EMPTY, error: String(e) });
      });
  }, [id]);

  return state;
};

/** The party's loadouts keyed by `actorIndex` — the same key a hit carries as
 * its `sourceIndex`, so a hit's cap-up record and the loadout it is itemized
 * against always describe one player. */
export const usePlayersByActor = (players: PlayerData[]) =>
  useMemo(() => new Map(players.map((player) => [player.actorIndex, player])), [players]);
