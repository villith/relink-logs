import { invoke } from "@tauri-apps/api";
import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

import type { EncounterStateResponse } from "@/stores/useEncounterStore";
import type {
  AbilitySeries,
  ActionType,
  EncounterState,
  GroupAbilityFilter,
  GroupAggregate,
  SelectionFact,
  SkillRow,
  TargetEntry,
  WireGroupQuery,
} from "@/types";

import { actionsForPin, rowKeyingFor, type RowKeying } from "../../abilitySkills";
import { takenAttackRowParts } from "../../metrics/damageTaken";
import type { SelectorPins } from "../../selectorOptions";
import { isStatusPin } from "../../statusUptime";
import { answeredGroups } from "../machine/answeredGroups";
import type { MetricCapabilities } from "../machine/capabilities";
import type { ViewSpec } from "../machine/resolve";
import type { Dimension, MetricKey } from "../machine/state";

/** Stable empty map, so the drill memo below does not rebuild every render on a
 * fresh `{}` literal. */
const EMPTY_ABILITY_SERIES: Record<number, AbilitySeries[]> = {};

/** Why a scoped fetch is needed, as five independent reasons.
 *
 * Named and separated because each one is reachable WITHOUT the others, and a
 * single boolean hid that: a regroup to stun's ability dimension with nothing
 * pinned (`wantsBands`) is a real request that none of the pin, window or mask
 * clauses can see. */
export type ScopeReasons = {
  /** A source, a non-status ability, or a target is pinned. */
  pinned: boolean;
  /** The chart has been scrubbed to a committed window. */
  isWindowed: boolean;
  /** An aura or battle-window filter is active. */
  hasMask: boolean;
  /** This grouping needs per-ability bands the base load never asks for. */
  wantsBands: boolean;
  /** The requested grouping is one the base load's own query did not answer. */
  needsGroups: boolean;
};

/** Whether the scoped fetch has anything to ask that the base load has not
 * already answered. False means the base response IS the answer, and repeating
 * it would cost a decompress-and-reparse for no new information. */
export const needsScopedFetch = ({ pinned, isWindowed, hasMask, wantsBands, needsGroups }: ScopeReasons): boolean =>
  pinned || isWindowed || hasMask || wantsBands || needsGroups;

export type EncounterData = {
  /** The aggregates the groups path renders, and the grouping they ANSWER —
   * not always the one now requested (see `answeredGroups`). */
  groups: GroupAggregate[];
  chartGroupBy: Dimension;
  scopedAbilitySeries: Record<number, AbilitySeries[]>;
  shownEncounter: EncounterState | null;
  facts: SelectionFact[];
  /** Every action anyone used in the whole fight, for expanding a pinned row
   * into the raw actions behind it. */
  everySkill: SkillRow[];
  rowKeying: RowKeying;
  /** A condensed group pin expanded into the raw action ids behind it. */
  pinnedActions: ActionType[];
};

export type EncounterDataInput = {
  id: string | undefined;
  filters: unknown;
  loadFromResponse: (response: EncounterStateResponse) => void;
  encounter: EncounterState | null;
  baseFacts: SelectionFact[];
  baseGroups: GroupAggregate[];
  targetEntries: TargetEntry[];
  pins: SelectorPins;
  spec: ViewSpec;
  caps: MetricCapabilities;
  /** The committed scrub, as bucket indexes. */
  window: [number, number] | null;
  range: [number, number] | null;
  maskWindows: { fromMs: number; upToMs: number }[] | undefined;
  collapseSupplementary: boolean;
  metricKey: MetricKey;
  bucketMs: number;
};

/** The view's whole data layer: the base load, the scoped fetch, and the
 * request identities that decide when either runs.
 *
 * Moved out of `AnalysisView` verbatim. The comments here carry the
 * response-ordering and early-out reasoning, which is the most delicate part of
 * the view — none of it is paraphrased. */
export const useEncounterData = ({
  id,
  filters,
  loadFromResponse,
  encounter,
  baseFacts,
  baseGroups,
  targetEntries,
  pins,
  spec,
  caps,
  window: stateWindow,
  range,
  maskWindows,
  collapseSupplementary,
  metricKey,
  bucketMs,
}: EncounterDataInput): EncounterData => {
  // Meter state, facts and group aggregates re-derived under the current
  // pins, window and grouping. Null means "the base load already says it".
  const [scoped, setScoped] = useState<{
    state: EncounterState;
    facts: SelectionFact[];
    groups: GroupAggregate[];
    /** WHICH GROUPING `groups` answers. Carried with the data because the
     * requested grouping flips a fetch earlier than the data does — see
     * `answeredGroups`, which is where this is read. Null when the request
     * carried no group query, which is every non-groups metric. */
    groupsGroupBy: Dimension | null;
    /** The drilled Stun/SBA bands, keyed by player. Only this fetch carries
     * them — the base load ignores pins, and a drill IS a pin. */
    abilitySeries: Record<number, AbilitySeries[]>;
  } | null>(null);

  // Responses are not ordered with respect to their requests (the command is
  // `#[tauri::command(async)]`), so each one drops itself once superseded.
  // Counted separately from the base load: a pin change must not cancel a load.
  const loadGeneration = useRef(0);
  const scopeGeneration = useRef(0);

  // The wire query the base load sent (as its JSON identity), so the scoped
  // effect can tell "the base response already answered this grouping" from
  // "a regroup needs its own fetch". Refs rather than deps: the base load
  // must not re-run — full charts and party — on every pin or regroup.
  const wireQueryRef = useRef<WireGroupQuery | undefined>(undefined);
  const baseQueryKeyRef = useRef<string | null>(null);
  // And which grouping the base load's own aggregates answer — null when it
  // carried no group query at all. The base-load half of `answeredGroups`.
  const baseGroupByRef = useRef<Dimension | null>(null);

  // The base load: the full fight, unpinned. Owns the charts, the party and the
  // quest metadata, none of which a pin changes. Carries the CURRENT group
  // query too, so the groups path has rows and bands on first paint.
  useEffect(() => {
    const generation = ++loadGeneration.current;
    scopeGeneration.current += 1;
    const groupQuery = wireQueryRef.current;
    baseQueryKeyRef.current = groupQuery === undefined ? null : JSON.stringify(groupQuery);
    baseGroupByRef.current = groupQuery?.groupBy ?? null;
    invoke("fetch_encounter_state", { id: Number(id), options: { filters, groupQuery } })
      .then((result) => {
        if (generation !== loadGeneration.current) return;
        loadFromResponse(result as EncounterStateResponse);
        setScoped(null);
      })
      .catch((e) => {
        if (generation !== loadGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, filters, loadFromResponse]);

  // A pinned target is a SPAWN (an index into `targetEntries`), and the backend
  // filters by that spawn's span. Deliberately not the actor id: the game
  // reissues a dead boss's id to a later one, so filtering by id sent every span
  // that id ever had and pinning Wilinus Icewyrm also returned Vrazarek
  // Firewyrm's damage. An index with no entry is dropped rather than widening
  // the filter — a stale URL narrows to nothing, which the empty table shows.
  const targetSpans = useMemo(
    () =>
      pins.targets
        .map((segment) => targetEntries[segment])
        .filter((entry) => entry !== undefined)
        .map((entry) => ({ id: entry.id, startMs: entry.startMs, endMs: entry.endMs })),
    [pins.targets, targetEntries]
  );

  // Every action anyone used in the WHOLE fight, for expanding a pinned row into
  // the raw actions behind it. The base load, not the scoped state: the scoped
  // one is already narrowed by the very pin being expanded.
  //
  // Breakdown rows AND facts. A breakdown row carries only the payload its row
  // was folded onto, so the echo row names one `SupplementaryDamage(n)` of the
  // dozens it aggregates; the facts carry each distinct action, which is what
  // makes a pinned echo filter to the same damage the row reports.
  const everySkill = useMemo(
    () => [
      ...Object.values(encounter?.party ?? {}).flatMap((player) => player.skillBreakdown),
      ...baseFacts.map((fact) => ({ actionType: fact.ability, childCharacterType: fact.childCharacterType ?? "" })),
    ],
    [encounter, baseFacts]
  );

  // THE view's row keying, built once from the same actions the table, the
  // chart and the timeline all draw from. Passed down rather than re-derived per
  // surface: a band and the row it decomposes have to agree about which row an
  // echo is on, and deriving it three times is how they would come to differ.
  //
  // Gated on the metric as well as the toggle, because only Damage Done records
  // supplementary damage — the toggle disables itself on the other tabs, and
  // this makes it inert there even if it were left on from a shared link.
  const rowKeying = useMemo(
    () => rowKeyingFor(everySkill, collapseSupplementary && caps.recordsSupplementary),
    [everySkill, collapseSupplementary, caps.recordsSupplementary]
  );

  // A pinned row can be a condensed GROUP, which the backend knows nothing
  // about — it filters on raw action ids. Expanded here, from what the party
  // actually used, so the parser stays free of a display concern and the filter
  // can never widen to ids nobody landed.
  // A status pin names an effect, not an action — the backend filters on raw
  // action ids and would narrow the fight to nothing at all. Left empty, the
  // damage tables stay whole while a buff is pinned on its own tab.
  const pinnedActions = useMemo(
    () =>
      pins.ability === null || isStatusPin(pins.ability) ? [] : actionsForPin(pins.ability, everySkill, rowKeying),
    [pins.ability, everySkill, rowKeying]
  );

  // The resolver's fetch, expanded into the wire shape: the raw ability pin
  // becomes whichever `AbilityFilter` grammar the query's event stream reads
  // (a friendly action list on the dealt stream, one enemy attack on the
  // taken one — a pin in the wrong grammar for the stream narrows nothing),
  // and the committed window is stamped on so the measures follow the scrub.
  const wireQuery = useMemo((): WireGroupQuery | undefined => {
    if (spec.fetch === null) return undefined;
    const dealtStream = (spec.fetch.metric === "damage") === (spec.fetch.hostility === "friendly");
    let ability: GroupAbilityFilter | null = null;
    if (spec.fetch.ability !== null) {
      const attack = takenAttackRowParts(spec.fetch.ability);
      if (dealtStream && attack === null) {
        // Through the same keying the table pins by: with the collapse on, a
        // cause row stands for its echoes' actions as well, and a filter that
        // left them out would fetch less than the row it was clicked on reports.
        ability = { kind: "friendly", actions: actionsForPin(spec.fetch.ability, everySkill, rowKeying) };
      } else if (!dealtStream && attack !== null) {
        ability = { kind: "enemyAttack", enemyType: attack.enemyType, actionId: attack.actionId };
      }
    }
    return {
      metric: spec.fetch.metric,
      hostility: spec.fetch.hostility,
      groupBy: spec.fetch.groupBy,
      source: spec.fetch.source,
      target: spec.fetch.target,
      ability,
      topN: spec.fetch.topN,
      // Buckets are inclusive at both ends, so the cutoff has to admit all of
      // the last one — `end * 1000` would window one bucket short.
      ...(stateWindow === null
        ? {}
        : { fromMs: stateWindow[0] * bucketMs, upToMs: (stateWindow[1] + 1) * bucketMs - 1 }),
      // The combined aura∩window mask rides the same query, so the table, the
      // rows and the chart bands all answer for the same filtered fight.
      ...(maskWindows === undefined ? {} : { windows: maskWindows }),
    };
  }, [spec.fetch, everySkill, rowKeying, stateWindow, maskWindows]);
  wireQueryRef.current = wireQuery;
  // The query's JSON identity, for "is a refetch needed at all" below — the
  // object is rebuilt every render, so identity comparison would always refetch.
  const wireQueryKey = useMemo(() => (wireQuery === undefined ? null : JSON.stringify(wireQuery)), [wireQuery]);

  // The scoped fetch's own request, everything `fetch_encounter_state` needs
  // BESIDES the group query (which rides `wireQueryRef` for the same reason).
  // `filters`, `targetSpans` and `pinnedActions` are fresh references on most
  // renders even when nothing they carry has changed — clicking between two
  // different status pins rebuilds `pinnedActions` to a new but equally EMPTY
  // array both times — so the effect below keys off this object's JSON
  // identity rather than the raw fields, the same idiom as `wireQuery`/
  // `wireQueryKey`.
  // The per-ability chart request. Only the derived-path tabs (Stun, SBA) drilled
  // by ability: damage and taken already get their bands from the group query,
  // and the aura tabs build theirs client-side from the status intervals.
  //
  // Rides the SCOPED fetch rather than the base load, because a drill is a pin
  // change and the base load deliberately ignores pins.
  const abilityQuery = useMemo(() => {
    if (caps.dataPath !== "derived" || spec.groupBy !== "ability") return undefined;
    return {
      metric: metricKey as "stun" | "sba",
      // Stun's ability level widens to the whole party with no source pinned
      // (see metrics/stun.ts); SBA has no party-wide reading, but its table is
      // empty there anyway, so one rule covers both.
      ...(pins.source === null ? {} : { player: pins.source }),
    };
  }, [caps.dataPath, spec.groupBy, metricKey, pins.source]);

  const scopedOptions = useMemo(
    () => ({
      filters,
      targetSpans,
      selection: {
        sourceIndices: pins.source === null ? [] : [pins.source],
        abilities: pinnedActions,
      },
      // Buckets are inclusive at both ends, so the cutoff has to admit all of
      // the last one — `end * 1000` would reparse a window one bucket short.
      ...(range === null ? {} : { fromMs: range[0] * bucketMs, upToMs: (range[1] + 1) * bucketMs - 1 }),
      ...(maskWindows === undefined ? {} : { windows: maskWindows }),
      // In `scopedOptions`, not bolted on at the call site like `groupQuery`,
      // so it lands in `scopedOptionsKey` too — otherwise regrouping to the
      // ability dimension would change the request without triggering it.
      ...(abilityQuery === undefined ? {} : { abilitySeries: abilityQuery }),
      stateOnly: true,
    }),
    [filters, targetSpans, pins.source, pinnedActions, range, maskWindows, abilityQuery]
  );
  const scopedOptionsRef = useRef(scopedOptions);
  scopedOptionsRef.current = scopedOptions;
  const scopedOptionsKey = useMemo(() => JSON.stringify(scopedOptions), [scopedOptions]);

  // The early-out's own inputs, in a ref rather than the fetch effect's
  // dependency array. `pins.ability` flipping between two status pins is a
  // genuine VALUE change but not a genuine REQUEST change (a status pin
  // narrows nothing the backend knows about — the request above deliberately
  // sends `abilities: []` for one); if that value change forced the effect to
  // rerun, the mask clause below would fall all the way through to a fetch
  // regardless — a mask makes the gate unconditional once inside, so keeping
  // the effect from firing AT ALL on a no-op change is the only lever left.
  const earlyOutRef = useRef({ pinned: false, isWindowed: false, hasMask: false, wantsBands: false });
  earlyOutRef.current = {
    pinned: pins.source !== null || (pins.ability !== null && !isStatusPin(pins.ability)) || targetSpans.length > 0,
    isWindowed: range !== null,
    hasMask: maskWindows !== undefined,
    // A regroup to the ability dimension with nothing pinned is a real request
    // (stun's party-wide ability level), and none of the clauses above see it.
    wantsBands: abilityQuery !== undefined,
  };

  // The scoped fetch: everything the selector bar, the window, the grouping
  // and the filter masks change. Keyed on `scopedOptionsKey`/`wireQueryKey` —
  // the request's own content — not the raw pins/spans/mask, so a request
  // byte-identical to the last one sent (clicking between two status pins,
  // for instance) does not repeat a decompress-and-reparse the store already
  // has the answer to. Sends `stateOnly` because the charts stay from the
  // base load — the backend still returns selection facts there, so the
  // cascade re-narrows with the window — and carries the group query for the
  // groups-path table.
  useEffect(() => {
    const { pinned, isWindowed, hasMask, wantsBands } = earlyOutRef.current;
    // A regroup with nothing pinned still needs ITS grouping's aggregates —
    // unless the base load already fetched this exact query.
    const needsGroups = wireQueryKey !== null && wireQueryKey !== baseQueryKeyRef.current;
    if (!pinned && !isWindowed && !needsGroups && !hasMask && !wantsBands) {
      setScoped(null);
      return;
    }

    const generation = ++scopeGeneration.current;
    // Captured from the request, not read back off the spec when the response
    // resolves: by then the user may have regrouped again, and the aggregates
    // would be stamped with a grouping they do not answer.
    const sentGroupBy = wireQueryRef.current?.groupBy;
    invoke("fetch_encounter_state", {
      id: Number(id),
      options: { ...scopedOptionsRef.current, groupQuery: wireQueryRef.current },
    })
      .then((result) => {
        if (generation !== scopeGeneration.current) return;
        const response = result as EncounterStateResponse;
        // Normalised here, at the boundary: the Rust binary does not hot-reload,
        // so a frontend ahead of its backend must degrade to "no groups"
        // rather than throw on a field the running binary never sends.
        setScoped({
          state: response.encounterState,
          facts: response.selectionFacts ?? [],
          groups: response.groups ?? [],
          // Stamped with the grouping the request asked for, so nothing
          // downstream can read these as answering a later one.
          groupsGroupBy: sentGroupBy ?? null,
          // Normalised at the boundary like `groups`: the Rust binary does not
          // hot-reload, so a frontend ahead of its backend degrades to no bands
          // — and therefore to the per-player lines — rather than throwing.
          abilitySeries: response.abilitySeries ?? {},
        });
      })
      .catch((e) => {
        if (generation !== scopeGeneration.current) return;
        toast.error(`Failed to fetch encounter state: ${e}`);
      });
  }, [id, scopedOptionsKey, wireQueryKey]);

  // Which aggregates the groups path renders — the scoped fetch's when one is
  // in hand, else the base load's — AND which grouping they answer, which is
  // not always the one now requested: a regroup flips `spec.groupBy` a fetch
  // before its aggregates arrive. Everything the CHART derives keys off
  // `chartGroupBy` rather than the request, so a regroup holds the previous
  // plot until its own data lands instead of stacking the old aggregates as
  // if they were the new ones (see `answeredGroups`).
  const { groups, groupBy: chartGroupBy } = answeredGroups(
    scoped === null ? null : { groups: scoped.groups, groupBy: scoped.groupsGroupBy },
    { groups: baseGroups, groupBy: baseGroupByRef.current },
    spec.groupBy
  );
  // No base-load fallback: the base load never asks for bands, so an empty map
  // is the honest answer whenever no scoped response has supplied them.
  const scopedAbilitySeries = scoped?.abilitySeries ?? EMPTY_ABILITY_SERIES;

  const shownEncounter = scoped?.state ?? encounter;

  // Cascading options come from the facts for the CURRENT window but with no
  // pin applied — a selector must keep offering what the other pins allow.
  const facts = scoped?.facts ?? baseFacts;

  return {
    groups,
    chartGroupBy,
    scopedAbilitySeries,
    shownEncounter,
    facts,
    everySkill,
    rowKeying,
    pinnedActions,
  };
};
