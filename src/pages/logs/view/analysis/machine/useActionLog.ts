import { useEffect, useReducer, useRef } from "react";

import { describeTransition, queryOf, summarizeState, type ActionEntry, type RecordedState } from "./actionLog";
import type { AnalysisState } from "./state";

/** How many steps the trail holds. A drilling session is nowhere near this, so
 * the cap is a backstop against a dev panel left open all evening rather than a
 * budget anyone is expected to spend. */
export const ACTION_LOG_LIMIT = 200;

export type ActionLog = {
  /** Oldest first — the order they were taken in. */
  entries: ActionEntry[];
  /** How many the cap discarded off the front. */
  dropped: number;
};

/** Everything the recorder carries between renders. One ref rather than four,
 * so a push cannot half-apply. */
type Recorder = ActionLog & { prev: RecordedState | null; seq: number; mountedAt: number };

const EMPTY: ActionLog = { entries: [], dropped: 0 };

/** Records what the user did to the analysis view, as transitions of the state
 * the URL holds.
 *
 * Every pin, metric, side, regroup, zoom, aura and window change lands in
 * `AnalysisState`, and the body switch lands in `tab`, so watching those two is
 * watching the whole set of actions that change what the view asks for. Nothing
 * else is instrumented: controls whose effect never reaches the URL (a hidden
 * legend band, an expanded skill group, the events column filters) are absent
 * by design, and the panel's state block names the ones that matter instead.
 *
 * Per MOUNT. Bouncing to the log list and back starts a fresh trail, which is
 * the point — a report should describe the visit that went wrong. */
export const useActionLog = (state: AnalysisState, tab: string | null): ActionLog => {
  // Re-render on a push. The entries live in a ref because a render must not be
  // what decides whether a step happened — that is the effect's job, and a
  // state-held buffer would make the recorder feed itself.
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const recorder = useRef<Recorder>({ ...EMPTY, prev: null, seq: 0, mountedAt: performance.now() });

  useEffect(() => {
    const next: RecordedState = { ...state, tab };
    const { prev, seq } = recorder.current;
    // By VALUE, not by identity: `state` is rebuilt whenever any URL key moves,
    // including keys this view does not own, and recording those would fill the
    // trail with actions nobody took.
    const deltas = prev === null ? [] : describeTransition(prev, next);
    if (prev !== null && deltas.length === 0) return;

    const atMs = performance.now() - recorder.current.mountedAt;
    const query = queryOf(next);
    const entry: ActionEntry =
      prev === null
        ? { kind: "opened", seq, atMs, summary: summarizeState(next), query }
        : { kind: "change", seq, atMs, deltas, query };

    // Rebuilt rather than pushed into: the returned array reaches memoised
    // children, and one mutated in place would compare equal to itself.
    const grown = [...recorder.current.entries, entry];
    const over = grown.length > ACTION_LOG_LIMIT;
    recorder.current = {
      entries: over ? grown.slice(1) : grown,
      dropped: recorder.current.dropped + (over ? 1 : 0),
      prev: next,
      // Numbering counts past a drop, so a truncated trail cannot read as
      // though it began at the oldest entry still held.
      seq: seq + 1,
      mountedAt: recorder.current.mountedAt,
    };
    bump();
  }, [state, tab]);

  return recorder.current;
};
