#!/usr/bin/env python3
"""Generate src/assets/summon-bonus-values.json from the game's summon_base_param.tbl.

The Builds tab uses this to show a summon equip-bonus's real magnitude instead of
its raw level: `bonus_id` (protocol EquippedSummon) keys this map, `bonus_level`
(0-indexed) indexes the ten-entry `values` array.

Regeneration on a game update (GBFRDataTools = github.com/Nenkai/GBFRDataTools):

    GBFRDataTools.exe extract -i <game>/data.i -f system/table/summon_base_param.tbl -o <tmp>
    GBFRDataTools.exe tbl-to-sqlite -i <tmp>/system/table -o <tmp>/summon.sqlite -v <game-version>
    python scripts/gen-summon-bonus-values.py <tmp>/summon.sqlite

Values are display-ready: raw LevelNValue x ValueDisplayMultiplier, with `percent`
carrying the table's percent-display flag (Unk16).
"""

import json
import sqlite3
import sys
from pathlib import Path

OUT_PATH = Path(__file__).resolve().parent.parent / "src" / "assets" / "summon-bonus-values.json"


def clean(value: float) -> float | int:
    rounded = round(value, 2)
    return int(rounded) if rounded == int(rounded) else rounded


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <summon_base_param sqlite db>")

    db = sqlite3.connect(sys.argv[1])
    out: dict[str, dict] = {}
    rows = db.execute(
        "SELECT Key, Level1Value, Level2Value, Level3Value, Level4Value, Level5Value, "
        "Level6Value, Level7Value, Level8Value, Level9Value, Level10Value, "
        "ValueDisplayMultiplier, Unk16 FROM summon_base_param"
    )
    for key, *levels_and_meta in rows:
        levels, multiplier, percent_flag = levels_and_meta[:10], levels_and_meta[10], levels_and_meta[11]
        # The 'EX' row is a zeroed dummy, and its key is not an id hash.
        if len(key) != 8:
            continue
        out[key.lower()] = {
            "values": [clean(level * multiplier) for level in levels],
            "percent": bool(percent_flag),
        }

    OUT_PATH.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(out)} bonuses to {OUT_PATH}")


if __name__ == "__main__":
    main()
