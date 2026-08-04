#!/usr/bin/env python3
"""Generate src-hook/src/hooks/status_levels.rs from the game's status.tbl.

`StatusBase+0xb0` is a true stack/level count only for the classes `status.tbl`
marks `HasLevels`. For every other status the field is uninitialised (the
factory writes -1) or holds something else entirely — barrier keeps its absorb
value there — so the hook cannot read it without knowing which ids are which,
and until it did it published a hardcoded 1 for everything.

Baked into the hook as a sorted const rather than shipped as an asset: the hook
is a DLL injected into the game with no access to the app's resources, and this
is 64 u32s that only change when the game does.

Regeneration on a game update (GBFRDataTools = github.com/Nenkai/GBFRDataTools):

    GBFRDataTools.exe extract -i <game>/data.i -f system/table/status.tbl -o <tmp>
    GBFRDataTools.exe tbl-to-sqlite -i <tmp>/system/table -o <tmp>/status.sqlite -v <game-version>
    python scripts/gen-stackable-statuses.py <tmp>/status.sqlite
"""

import sqlite3
import sys
from pathlib import Path

OUT_PATH = (
    Path(__file__).resolve().parent.parent / "src-hook" / "src" / "hooks" / "status_levels.rs"
)

HEADER = '''//! Which statuses carry a real stack count. GENERATED — do not edit by hand.
//!
//! Regenerate with `scripts/gen-stackable-statuses.py` after a game update; the
//! source is `status.tbl`'s `HasLevels` column.
//!
//! `StatusBase+0xb0` is a stack/level count ONLY for these ids. Elsewhere the
//! factory's pre-init -1 is still there, or the class uses the field for
//! something else (barrier stores its absorb value in it), so reading it
//! unconditionally would publish garbage as a stack count.

/// `status.tbl` ids whose `+0xb0` is a stack count, sorted for binary search.
pub(super) const STACKABLE_STATUS_IDS: [u32; {count}] = [
{ids}];

/// Whether `+0xb0` means "stacks" for this status.
pub(super) fn has_levels(status_id: u32) -> bool {{
    STACKABLE_STATUS_IDS.binary_search(&status_id).is_ok()
}}

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn the_table_is_sorted_for_binary_search() {{
        assert!(STACKABLE_STATUS_IDS.windows(2).all(|pair| pair[0] < pair[1]));
    }}

    #[test]
    fn known_stackable_and_non_stackable_ids() {{
        // damagecut (4) is the first HasLevels row; atkup (0) is the most
        // common buff in the game and is NOT stackable, which is what makes a
        // wrong answer here so visible.
        assert!(has_levels(4));
        assert!(!has_levels(0));
        // barrier (41) keeps its ABSORB value at +0xb0 — the exact field this
        // table exists to stop the hook from reading as a stack count.
        assert!(!has_levels(41));
    }}
}}
'''


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <status.tbl sqlite db>")

    db = sqlite3.connect(sys.argv[1])
    ids = [
        row[0]
        for row in db.execute(
            "SELECT StatusId FROM status WHERE HasLevels != 0 ORDER BY StatusId"
        )
    ]

    # Names in a trailing comment per line would churn the diff on every text
    # change; the ids alone are the contract.
    lines = "".join(f"    {status_id},\n" for status_id in ids)
    OUT_PATH.write_text(
        HEADER.format(count=len(ids), ids=lines), encoding="utf-8", newline="\n"
    )
    print(f"wrote {len(ids)} stackable status ids to {OUT_PATH}")


if __name__ == "__main__":
    main()
