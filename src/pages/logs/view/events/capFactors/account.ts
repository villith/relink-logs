import { unknownResult, type CapFactor } from "./types";

/**
 * The account-wide cap-up terms, named but unresolvable.
 *
 * Master trait rank and Mastery/Collection progress both raise the damage cap
 * and neither is in the log — they are account state, not encounter state, and
 * no table shipped with the app converts them into a percentage.
 *
 * They are here anyway, and that is the point. A residual called "Unaccounted"
 * tells a reader nothing about whether the model is missing a source or merely
 * missing a number. Two rows saying "this is the master rank bonus, and this
 * log cannot value it" turn an anonymous gap into a known one.
 */

/** Not real ids — these terms have no game entity behind them. The renderer
 * takes their name from `label` and never looks an id up. */
const NO_ID = 0;

export const accountFactors = (): CapFactor[] => [
  {
    key: "account-master-rank",
    kind: "account",
    id: NO_ID,
    label: "ui.debug.cap-master-rank",
    level: null,
    params: [],
    evaluate: () => unknownResult(0, [], "value-unrecorded"),
  },
  {
    key: "account-mastery",
    kind: "account",
    id: NO_ID,
    label: "ui.debug.cap-mastery-collection",
    level: null,
    params: [],
    evaluate: () => unknownResult(0, [], "value-unrecorded"),
  },
];
