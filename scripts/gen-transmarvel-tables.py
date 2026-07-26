#!/usr/bin/env python3
"""Generate src-tauri/assets/transmarvel-tables.json from the game's gacha
tables.

Feeds the Toolbox transmarvel-roll predictor (src-tauri/src/transmarvel/):
the transmarvel roll (ui::fsm::action::GemGacha exec, FUN_141bb6610 v2.0.2)
is a pure function of these tables plus RNG slot 4's state, so the tables
are baked at build time and only the RNG state is read from the live game.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/gacha.tbl -o <dir>
     (same for gacha_rate_group.tbl, gacha_lot.tbl)
  2. GBFRDataTools tbl-to-sqlite -i <dir>/system/table -v 2.0.2
  3. python scripts/gen-transmarvel-tables.py <dir>/system/db.sqlite

Output shape (camelCase, deserialized by transmarvel::TransmarvelTables):
  gemChancePercent / wrightstoneChancePercent — the first draw's split
    (draw % 100 < gemChancePercent -> gem).
  gemGroups / stoneGroups — rate groups IN TABLE ORDER (the roll's
    cumulative weighted pick walks this order; weights sum to 10000), each
    with its lot's items IN TABLE ORDER (same cumulative pick over item
    weights; all 50 for transmarvel = uniform).
  Per item: quest gates (questIdMin/questIdMax, 0 = ungated) and the
  endless-Ragnarok-unlock flag, so the simulation can drop locked items the
  way the roll's availability filter does. The owned-unique-sigil exclusion
  is a live-memory input, not a table property.
"""

import json
import sqlite3
import sys
from pathlib import Path

from gbfr_hash import cell_hash

OUT_PATH = Path(__file__).resolve().parent.parent / "src-tauri" / "assets" / "transmarvel-tables.json"

# gacha.tbl row Key for the transmarvel tier (TXT_YOROZU_FORGING_HIGH).
TRANSMARVEL_KEY = 0xFA21E311


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <db.sqlite> (see module docstring)")
    db = sqlite3.connect(sys.argv[1])
    db.row_factory = sqlite3.Row

    tier = None
    for row in db.execute(
        "SELECT Key, GemChancePercent, WrightstoneChancePercent, "
        "GemRateGroup, WrightstoneRateGroup FROM gacha ORDER BY rowid"
    ):
        if cell_hash(row["Key"]) == TRANSMARVEL_KEY:
            tier = row
    assert tier is not None, "transmarvel gacha row not found"

    items_by_lot = {}
    for row in db.execute(
        "SELECT Key, ItemId, Weight, TraitLevel, QuestIDMin, QuestIDMax, "
        "NeedsEndlessRagnarokToDrop FROM gacha_lot ORDER BY rowid"
    ):
        items_by_lot.setdefault(cell_hash(row["Key"]), []).append(
            {
                "item": cell_hash(row["ItemId"]),
                "weight": row["Weight"],
                "traitLevel": row["TraitLevel"],
                "questIdMin": cell_hash(row["QuestIDMin"]) or 0,
                "questIdMax": cell_hash(row["QuestIDMax"]) or 0,
                "needsEndlessRagnarok": bool(row["NeedsEndlessRagnarokToDrop"]),
            }
        )

    def groups(rate_group_cell: str) -> list:
        key = cell_hash(rate_group_cell)
        out = []
        for row in db.execute(
            "SELECT Key, GachaLotId, Weight FROM gacha_rate_group ORDER BY rowid"
        ):
            if cell_hash(row["Key"]) != key:
                continue
            lot = cell_hash(row["GachaLotId"])
            assert lot in items_by_lot, f"rate group references unknown lot {lot:08x}"
            out.append({"lot": lot, "weight": row["Weight"], "items": items_by_lot[lot]})
        total = sum(g["weight"] for g in out)
        assert total == 10000, f"group weights sum to {total}, expected 10000"
        return out

    out = {
        "gemChancePercent": tier["GemChancePercent"],
        "wrightstoneChancePercent": tier["WrightstoneChancePercent"],
        "gemGroups": groups(tier["GemRateGroup"]),
        "stoneGroups": groups(tier["WrightstoneRateGroup"]),
    }
    OUT_PATH.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    n_gem = sum(len(g["items"]) for g in out["gemGroups"])
    n_stone = sum(len(g["items"]) for g in out["stoneGroups"])
    print(
        f"wrote {OUT_PATH} — {len(out['gemGroups'])} gem groups ({n_gem} items), "
        f"{len(out['stoneGroups'])} stone groups ({n_stone} items)"
    )


if __name__ == "__main__":
    main()
