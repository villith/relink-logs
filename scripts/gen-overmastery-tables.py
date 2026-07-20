#!/usr/bin/env python3
"""Generate src-tauri/assets/overmastery-tables.json from the game's
limit_bonus meditation tables.

Feeds the Toolbox overmastery-roll predictor (src-tauri/src/overmastery/):
the meditation roll (FUN_141beb1b0, v2.0.2) is a pure function of these
tables plus the per-character RNG slot state, so the tables are baked at
build time and only the RNG state is read from the live game.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/limit_bonus_meditation.tbl -o <dir>
     (same for limit_bonus_meditation_category.tbl, limit_bonus_meditation_weight.tbl,
      limit_bonus_param.tbl)
  2. GBFRDataTools tbl-to-sqlite -i <dir>/system/table -v 2.0.2
  3. python scripts/gen-overmastery-tables.py <dir>/system/table/db.sqlite

Output shape (camelCase, deserialized by overmastery::OvermasteryTables):
  tiers        — per size 0/1/2 (small/medium/large): the three
                 (numMasteries, weight) options, MSP cost, guarantee percent
                 (sqlite col "Unk11"; the ATK+HP guarantee chance).
  pools        — category pools per size, IN TABLE ORDER (the roll's
                 direct-picks and cumulative weighted picks walk this order).
  levelWeights — 10 rows x [small, medium, large] weights; picked row index
                 (0-based, clamped 1..9) is the level bit -> Lv(bit+1)Value.
  params       — pool key (decimal string) -> { kind, values[10] }. kind is
                 the category type (sqlite col "DisplayNumberMultiplier" is
                 misnamed: ATK=0 HP=1 CRIT=2 BREAK=3, specials 100+).
"""

import json
import sqlite3
import sys
from pathlib import Path

from gbfr_hash import cell_hash

OUT_PATH = Path(__file__).resolve().parent.parent / "src-tauri" / "assets" / "overmastery-tables.json"
# Frontend copy: per size, the distinct effects in pool order with how often
# each exists in the pool (the category picker's option list; the small pool's
# duplicate rows are separate pickable entries, so one roll can contain e.g.
# ATK up to 5 times — `count` caps how many picker slots may want the effect).
CATEGORIES_PATH = Path(__file__).resolve().parent.parent / "src" / "assets" / "overmastery-categories.json"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <db.sqlite> (see module docstring)")
    db = sqlite3.connect(sys.argv[1])
    db.row_factory = sqlite3.Row

    tiers = []
    for row in db.execute(
        "SELECT NumMasteries1, NumMasteries2, NumMasteries3, "
        "NumMasteriesWeight1, NumMasteriesWeight2, NumMasteriesWeight3, "
        "MeditationCategoryId, MSPCost, Unk11 FROM limit_bonus_meditation ORDER BY rowid"
    ):
        assert row["MeditationCategoryId"] == len(tiers), "size rows out of order"
        tiers.append(
            {
                "counts": [
                    [row["NumMasteries1"], row["NumMasteriesWeight1"]],
                    [row["NumMasteries2"], row["NumMasteriesWeight2"]],
                    [row["NumMasteries3"], row["NumMasteriesWeight3"]],
                ],
                "mspCost": row["MSPCost"],
                "guaranteePct": row["Unk11"],
            }
        )

    pools = [[] for _ in tiers]
    pool_keys = set()
    for row in db.execute(
        "SELECT Key, MeditationWeightId, Weight FROM limit_bonus_meditation_category ORDER BY rowid"
    ):
        key = cell_hash(row["Key"])
        assert key is not None, f"category row with empty key: {dict(row)}"
        pools[row["MeditationWeightId"]].append({"key": key, "weight": row["Weight"]})
        pool_keys.add(key)

    level_weights = [
        [row["WeightLv1"], row["WeightLv2"], row["WeightLv3"]]
        for row in db.execute(
            "SELECT WeightLv1, WeightLv2, WeightLv3 FROM limit_bonus_meditation_weight ORDER BY rowid"
        )
    ]
    assert len(level_weights) == 10, f"expected 10 weight rows, got {len(level_weights)}"

    params = {}
    lv_cols = ", ".join(f"Lv{i}Value" for i in range(1, 11))
    for row in db.execute(
        f"SELECT Key, DisplayNumberMultiplier, {lv_cols} FROM limit_bonus_param"
    ):
        key = cell_hash(row["Key"])
        if key not in pool_keys:
            continue
        params[key] = {
            "kind": row["DisplayNumberMultiplier"],
            "values": [row[f"Lv{i}Value"] for i in range(1, 11)],
        }

    missing = pool_keys - params.keys()
    assert not missing, f"pool keys without params: {[hex(k) for k in missing]}"

    out = {"tiers": tiers, "pools": pools, "levelWeights": level_weights, "params": params}
    OUT_PATH.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    sizes = [len(p) for p in pools]
    print(f"wrote {OUT_PATH} — {len(tiers)} sizes, pools {sizes}, {len(params)} params")

    # The picker offers EFFECTS: pool keys collapse to their kind, keeping how
    # many pool rows share it (duplicate rows can co-occur in one roll). `key`
    # is a representative hash for translation via overmasteries.json.
    categories = {}
    for tier_idx, pool in enumerate(pools):
        by_kind = {}
        for entry in pool:
            kind = params[entry["key"]]["kind"]
            if kind in by_kind:
                by_kind[kind]["count"] += 1
            else:
                by_kind[kind] = {"kind": kind, "key": f"{entry['key']:08x}", "count": 1}
        categories[str(tier_idx)] = list(by_kind.values())
    CATEGORIES_PATH.write_text(json.dumps(categories, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {CATEGORIES_PATH} — {[len(v) for v in categories.values()]} distinct effects")


if __name__ == "__main__":
    main()
