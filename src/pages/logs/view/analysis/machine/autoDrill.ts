import type { MetricRow } from "../../metrics/types";

import { isPinned, type AnalysisState } from "./state";
import { pinValueOf, type PinValue } from "./transitions";

/** The pin a table with nothing left to choose applies to itself, or null.
 *
 * A drill that lands on ONE row has asked its question and answered it in the
 * same breath: clicking that row is the only move it offers, so the view makes
 * it. The rule is the row's own `pinOnClick` — the same payload a click would
 * send — so an auto-drill can never pin something a click there would not.
 *
 * Null on a dimension that is ALREADY pinned, which is what stops it: each drill
 * consumes a free dimension, so the walk terminates at the deepest table (where
 * the lone row IS the pinned reading, and repinning it would spin — every
 * transition returns a fresh state object, so a repin re-renders forever). */
export const autoDrillPin = (rows: MetricRow[], state: AnalysisState): PinValue | null => {
  if (rows.length !== 1) return null;
  const pin = pinValueOf(rows[0].pinOnClick);
  if (pin === null) return null;
  return isPinned(state, pin.dim) ? null : pin;
};
