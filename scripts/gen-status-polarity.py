#!/usr/bin/env python3
"""Generate src/pages/logs/view/metrics/statusPolarity.ts from the game's status.tbl.

`PositiveStatusOrNegativeStatus` is the game's own polarity flag (1 = positive,
0 = negative). It is the ONLY honest source: `IsBuff` is 1 even for atkdown, and
`IsAilment` marks only the 1000+ family, missing low-id debuffs like defdown.
The Buffs and Debuffs tables split effects by this flag; before it existed they
split by HOLDER, which filed enemy self-buffs (Bloodthirst) as debuffs.

Regeneration on a game update (GBFRDataTools = github.com/Nenkai/GBFRDataTools):

    GBFRDataTools.exe extract -i <game>/data.i -f system/table/status.tbl -o <tmp>
    GBFRDataTools.exe tbl-to-sqlite -i <tmp>/system/table -o <tmp>/status.sqlite -v <game-version>
    python scripts/gen-status-polarity.py <tmp>/status.sqlite
"""

import sqlite3
import sys
import textwrap
from pathlib import Path

OUT_PATH = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "pages"
    / "logs"
    / "view"
    / "metrics"
    / "statusPolarity.ts"
)

HEADER = """// Which statuses are harmful to their holder. GENERATED — do not edit by hand.
// Regenerate with `scripts/gen-status-polarity.py` after a game update; the
// source is `status.tbl`'s `PositiveStatusOrNegativeStatus` column (1 =
// positive, 0 = negative — the game's own polarity, and the only honest one:
// `IsBuff` is 1 even for atkdown, and `IsAilment` misses low-id debuffs).

/** `status.tbl` ids whose `PositiveStatusOrNegativeStatus` is 0. */
export const HARMFUL_STATUS_IDS: ReadonlySet<number> = new Set([
{ids}]);

/** Whether an effect hurts whoever holds it — the Buffs/Debuffs split.
 *
 * An unknown id (a future patch's new status) answers "beneficial": it misfiles
 * one row until the table is regenerated, but dropping it would lose the row
 * entirely. */
export const isHarmful = (statusId: number): boolean => HARMFUL_STATUS_IDS.has(statusId);
"""


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <status.tbl sqlite db>")

    db = sqlite3.connect(sys.argv[1])
    ids = [
        row[0]
        for row in db.execute(
            "SELECT StatusId FROM status WHERE PositiveStatusOrNegativeStatus = 0 ORDER BY StatusId"
        )
    ]

    # Format with line wrapping to match .prettierrc's printWidth: 120
    formatted_ids = textwrap.fill(
        ", ".join(str(i) for i in ids) + ",",
        width=120,
        initial_indent="  ",
        subsequent_indent="  ",
    )
    OUT_PATH.write_text(
        HEADER.format(ids=formatted_ids + "\n"), encoding="utf-8", newline="\n"
    )
    print(f"wrote {len(ids)} harmful status ids to {OUT_PATH}")


if __name__ == "__main__":
    main()
