// Which statuses are harmful to their holder. GENERATED — do not edit by hand.
// Regenerate with `scripts/gen-status-polarity.py` after a game update; the
// source is `status.tbl`'s `PositiveStatusOrNegativeStatus` column (1 =
// positive, 0 = negative — the game's own polarity, and the only honest one:
// `IsBuff` is 1 even for atkdown, and `IsAilment` misses low-id debuffs).

/** `status.tbl` ids whose `PositiveStatusOrNegativeStatus` is 0. */
export const HARMFUL_STATUS_IDS: ReadonlySet<number> = new Set([
  2, 3, 15, 37, 51, 59, 67, 73, 81, 108, 111, 113, 126, 134, 145, 147, 149, 1000, 1001, 1002, 1003, 1004, 1005, 1006,
  1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021,
]);

/** Whether an effect hurts whoever holds it — the Buffs/Debuffs split.
 *
 * An unknown id (a future patch's new status) answers "beneficial": it misfiles
 * one row until the table is regenerated, but dropping it would lose the row
 * entirely. */
export const isHarmful = (statusId: number): boolean => HARMFUL_STATUS_IDS.has(statusId);
