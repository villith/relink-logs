import { useCallback, useEffect, useRef } from "react";

import type { MetricRow } from "../../metrics/types";

import { autoDrillPin } from "./autoDrill";
import type { AnalysisState } from "./state";
import { pinRow } from "./transitions";

export type AutoDrillInput = {
  /** The rows the body on screen is drawing. */
  rows: MetricRow[];
  state: AnalysisState;
  setState: (next: AnalysisState) => void;
  /** Whether `rows` answer the CURRENT grouping. The groups path flips the
   * requested grouping a fetch before its aggregates arrive (see
   * `answeredGroups`), and the rows folded in between are the PREVIOUS
   * question's — drilling one of those pins an answer to a question nobody
   * asked. False holds the drill rather than cancelling it. */
  settled: boolean;
  /** Whether these rows are the body actually on screen. A drill nobody can
   * see is a pin that appears from nowhere, so the events view — which draws
   * no rows at all — takes none. */
  enabled: boolean;
};

/** WCL's drill, carried one step further: a pin that leaves the table with a
 * single row drills into that row too, and keeps going while each new table is
 * left with one.
 *
 * ARMED BY THE PIN, rather than standing as an invariant over the rows. A rule
 * that pinned any single-row table it ever saw would make that pin impossible to
 * clear — clearing it returns to the one-row table the rule just fired on, so
 * the ✕ would silently undo itself. So only a drill drills: `armDrill` is called
 * where the user pins, and the walk stops at the first table that offers a real
 * choice.
 */
export const useAutoDrill = ({ rows, state, setState, settled, enabled }: AutoDrillInput) => {
  // A ref, not state: arming happens inside the click that pins, and a render
  // of its own there would be a second one for nothing. The pin's own state
  // change is what brings the effect below round.
  const armed = useRef(false);
  const armDrill = useCallback(() => {
    armed.current = true;
  }, []);

  useEffect(() => {
    if (!armed.current) return;
    if (!enabled) {
      armed.current = false;
      return;
    }
    // The rows in hand answer the previous grouping: wait for the ones that
    // answer this drill rather than reading those as its result.
    if (!settled) return;
    const pin = autoDrillPin(rows, state);
    if (pin === null) {
      armed.current = false;
      return;
    }
    // Still armed: the table this pin produces may be down to one row too, and
    // the walk should continue. It terminates on its own — every step consumes
    // a free dimension, and `autoDrillPin` answers null once none are left.
    setState(pinRow(state, pin));
  }, [rows, state, setState, settled, enabled]);

  return { armDrill };
};
